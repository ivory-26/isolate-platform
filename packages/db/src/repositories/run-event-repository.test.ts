import { expect, test } from "bun:test";
import { asOrganizationId, asTaskId } from "@isolate/shared";
import { InMemoryRunEventRepository } from "../testing/execution-truth-fakes";
import { InMemoryTaskRepository } from "../testing/fakes";
import {
	clampPageLimit,
	DEFAULT_PAGE_LIMIT,
	MAX_PAGE_LIMIT,
} from "./pagination";

const orgA = asOrganizationId("10000000-0000-4000-8000-000000000001");
const orgB = asOrganizationId("10000000-0000-4000-8000-000000000002");
const user = "30000000-0000-4000-8000-000000000001";

function clockFrom(startIso = "2026-10-31T12:00:00.000Z"): () => Date {
	let ms = new Date(startIso).getTime();
	return () => {
		ms += 1000;
		return new Date(ms);
	};
}

async function seedTask(tasks: InMemoryTaskRepository) {
	return tasks.create({
		organizationId: orgA,
		repositoryId: "20000000-0000-4000-8000-000000000001",
		branch: "task/events",
		idempotencyKey: `events-${crypto.randomUUID()}`,
		budgetLimits: {
			maxAgentTurns: 3,
			maxRepairAttempts: 0,
			maxDurationMs: 60000,
		},
		createdBy: user,
	});
}

test("clampPageLimit defaults, floors and bounds the page size", () => {
	expect(clampPageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
	expect(clampPageLimit(Number.NaN)).toBe(DEFAULT_PAGE_LIMIT);
	expect(clampPageLimit(0)).toBe(1);
	expect(clampPageLimit(-5)).toBe(1);
	expect(clampPageLimit(2.9)).toBe(2);
	expect(clampPageLimit(10_000)).toBe(MAX_PAGE_LIMIT);
	expect(DEFAULT_PAGE_LIMIT).toBe(100);
	expect(MAX_PAGE_LIMIT).toBe(500);
});

test("listByTask returns the timeline oldest-first with jsonb data intact", async () => {
	const tasks = new InMemoryTaskRepository();
	const events = new InMemoryRunEventRepository(tasks, clockFrom());
	const task = await seedTask(tasks);
	await events.append({
		organizationId: orgA,
		taskId: task.id,
		workflowRunId: null,
		type: "task.claimed",
		actor: "worker",
		data: { nested: { ok: true } },
	});
	await events.append({
		organizationId: orgA,
		taskId: task.id,
		workflowRunId: null,
		type: "task.retried",
		actor: "user",
		data: { sourceTaskId: task.id },
	});
	const listed = await events.listByTask({
		organizationId: orgA,
		taskId: task.id,
	});
	expect(listed.map((row) => row.type)).toEqual([
		"task.claimed",
		"task.retried",
	]);
	expect(listed[0].data).toEqual({ nested: { ok: true } });
	// Returned rows are copies: mutating the result never rewrites the store.
	listed[0].data.nested = false;
	expect(
		(await events.listByTask({ organizationId: orgA, taskId: task.id }))[0]
			.data,
	).toEqual({ nested: { ok: true } });
});

test("listByTask is tenant-scoped and bounded", async () => {
	const tasks = new InMemoryTaskRepository();
	const events = new InMemoryRunEventRepository(tasks, clockFrom());
	const task = await seedTask(tasks);
	for (const type of ["task.enqueued", "task.claimed", "task.state_changed"]) {
		await events.append({
			organizationId: orgA,
			taskId: task.id,
			workflowRunId: null,
			type,
			actor: "worker",
		});
	}
	expect(
		await events.listByTask({ organizationId: orgB, taskId: task.id }),
	).toEqual([]);
	expect(
		await events.listByTask({
			organizationId: orgA,
			taskId: asTaskId("60000000-0000-4000-8000-0000000000ff"),
		}),
	).toEqual([]);
	const page = await events.listByTask({
		organizationId: orgA,
		taskId: task.id,
		limit: 2,
	});
	expect(page.map((row) => row.type)).toEqual([
		"task.enqueued",
		"task.claimed",
	]);
});

test("append refuses to write an event for a foreign task", async () => {
	const tasks = new InMemoryTaskRepository();
	const events = new InMemoryRunEventRepository(tasks, clockFrom());
	const task = await seedTask(tasks);
	await expect(
		events.append({
			organizationId: orgB,
			taskId: task.id,
			workflowRunId: null,
			type: "task.claimed",
			actor: "worker",
		}),
	).rejects.toThrow(/not found in this organization/);
	expect(
		await events.listByTask({ organizationId: orgA, taskId: task.id }),
	).toEqual([]);
});
