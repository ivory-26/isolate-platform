import { beforeEach, describe, expect, test } from "bun:test";
import {
	asOrganizationId,
	asTaskId,
	type OrganizationId,
} from "@isolate/shared";
import { InMemoryArtifactRepository } from "../testing/execution-truth-fakes";
import { InMemoryTaskRepository } from "../testing/fakes";
import { MAX_INLINE_ARTIFACT_BYTES } from "./artifact-repository";
import type { TaskRepository } from "./task-repository";

const orgA = asOrganizationId("20000000-0000-4000-8000-000000000001");
const orgB = asOrganizationId("20000000-0000-4000-8000-000000000002");
const SHA = "0123456789abcdef".repeat(4);

let nextId = 0;
let now = new Date("2026-10-30T10:00:00.000Z");

async function seedTask(
	tasks: TaskRepository,
	organizationId: OrganizationId,
): Promise<{ taskId: string }> {
	nextId += 1;
	const task = await tasks.create({
		organizationId,
		repositoryId: crypto.randomUUID(),
		branch: `task/artifact-${nextId}`,
		idempotencyKey: `idem-${nextId}`,
		budgetLimits: {
			maxAgentTurns: 3,
			maxRepairAttempts: 1,
			maxDurationMs: 60000,
		},
		createdBy: "user-1",
	});
	return { taskId: task.id };
}

describe("InMemoryArtifactRepository (ArtifactRepository contract)", () => {
	let tasks: InMemoryTaskRepository;
	let artifacts: InMemoryArtifactRepository;

	beforeEach(() => {
		now = new Date("2026-10-30T10:00:00.000Z");
		tasks = new InMemoryTaskRepository();
		artifacts = new InMemoryArtifactRepository(tasks, () => new Date(now));
	});

	test("stores bounded inline content with storage_ref inline:<sha> and the supplied sha verbatim", async () => {
		const { taskId } = await seedTask(tasks, orgA);
		const content = "diff --git a/x b/x\n+hello\n";
		const result = await artifacts.create({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			kind: "diff",
			contentType: "text/x-diff",
			content,
			sha256: SHA,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.artifact).toMatchObject({
			organization_id: orgA,
			kind: "diff",
			storage_ref: `inline:${SHA}`,
			sha256: SHA,
			content,
			byte_size: Buffer.byteLength(content, "utf8"),
		});

		const listed = await artifacts.listByTask({
			organizationId: orgA,
			taskId: asTaskId(taskId),
		});
		expect(listed).toHaveLength(1);
		expect(listed[0].id).toBe(result.artifact.id);
	});

	test("accepts exactly 262144 bytes and rejects one byte more", async () => {
		const { taskId } = await seedTask(tasks, orgA);
		const atCap = await artifacts.create({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			kind: "diff",
			contentType: "text/plain",
			content: "a".repeat(MAX_INLINE_ARTIFACT_BYTES),
			sha256: SHA,
		});
		expect(atCap.ok).toBe(true);

		const overCap = await artifacts.create({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			kind: "diff",
			contentType: "text/plain",
			content: "a".repeat(MAX_INLINE_ARTIFACT_BYTES + 1),
			sha256: SHA,
		});
		expect(overCap).toEqual({ ok: false, code: "CONTENT_TOO_LARGE" });
	});

	test("the cap is measured in UTF-8 bytes, not characters", async () => {
		const { taskId } = await seedTask(tasks, orgA);
		// "é" is two bytes in UTF-8: 131072 chars = 262144 bytes (allowed).
		expect(
			await artifacts.create({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				kind: "diff",
				contentType: "text/plain",
				content: "é".repeat(131072),
				sha256: SHA,
			}),
		).toMatchObject({ ok: true });
		expect(
			await artifacts.create({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				kind: "diff",
				contentType: "text/plain",
				content: "é".repeat(131073),
				sha256: SHA,
			}),
		).toEqual({ ok: false, code: "CONTENT_TOO_LARGE" });
	});

	test("tenant isolation: foreign task is NOT_FOUND and foreign lists are empty", async () => {
		const { taskId } = await seedTask(tasks, orgA);
		const created = await artifacts.create({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			kind: "report",
			contentType: "text/plain",
			content: "ok",
			sha256: SHA,
		});
		expect(created.ok).toBe(true);

		expect(
			await artifacts.create({
				organizationId: orgB,
				taskId: asTaskId(taskId),
				kind: "report",
				contentType: "text/plain",
				content: "stolen",
				sha256: SHA,
			}),
		).toEqual({ ok: false, code: "NOT_FOUND" });
		expect(
			await artifacts.listByTask({
				organizationId: orgB,
				taskId: asTaskId(taskId),
			}),
		).toEqual([]);
		expect(
			await artifacts.listByTask({
				organizationId: orgA,
				taskId: asTaskId(crypto.randomUUID()),
			}),
		).toEqual([]);
	});

	test("listByTask returns newest first", async () => {
		const { taskId } = await seedTask(tasks, orgA);
		const first = await artifacts.create({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			kind: "diff",
			contentType: "text/plain",
			content: "first",
			sha256: SHA,
		});
		now = new Date(now.getTime() + 1000);
		const second = await artifacts.create({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			kind: "diff",
			contentType: "text/plain",
			content: "second",
			sha256: SHA,
		});
		if (!first.ok || !second.ok) throw new Error("seed failed");
		const listed = await artifacts.listByTask({
			organizationId: orgA,
			taskId: asTaskId(taskId),
		});
		expect(listed.map((row) => row.id)).toEqual([
			second.artifact.id,
			first.artifact.id,
		]);
	});

	test("an invalid digest is a caller error, rejected before insert", async () => {
		const { taskId } = await seedTask(tasks, orgA);
		expect(
			artifacts.create({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				kind: "diff",
				contentType: "text/plain",
				content: "ok",
				sha256: "not-a-digest",
			}),
		).rejects.toThrow(/64-char/);
		expect(
			await artifacts.listByTask({
				organizationId: orgA,
				taskId: asTaskId(taskId),
			}),
		).toEqual([]);
	});
});
