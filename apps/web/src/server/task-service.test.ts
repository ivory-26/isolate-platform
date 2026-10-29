import { describe, expect, test } from "bun:test";
import { asOrganizationId } from "@isolate/shared";
import { ControlPlaneError, createTaskService } from "./task-service.server";
import { harness, input, otherScope, scope } from "./test-fixtures";

describe("offline task control plane", () => {
	test("persists trusted scope and enqueues bounded metadata", async () => {
		const h = harness();
		const result = await h.service.submit(input());
		expect(h.tasks.calls[0]).toMatchObject({
			organizationId: scope.organizationId,
			createdBy: scope.userId,
			budgetLimits: {
				maxAgentTurns: 12,
				maxRepairAttempts: 2,
				maxDurationMs: 120000,
			},
		});
		expect(h.queue.calls[0]).toMatchObject({
			organizationId: scope.organizationId,
			type: "run_task",
			maxAttempts: 3,
		});
		if (!result.ok) throw new Error("Expected receipt");
		expect(h.queue.calls[0].payload).toEqual({ taskId: result.value.task.id });
		expect(Object.keys(result.value.task).sort()).toEqual(
			[
				"id",
				"repositoryId",
				"branch",
				"status",
				"createdAt",
				"updatedAt",
				"latestRun",
			].sort(),
		);
		expect(JSON.stringify(result)).not.toContain("idempotency");
	});
	test("parallel retries deduplicate task and queue", async () => {
		const h = harness();
		const request = input();
		const results = await Promise.all(
			Array.from({ length: 12 }, () => h.service.submit(request)),
		);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(new Set(results.map((r) => r.ok && r.value.jobId)).size).toBe(1);
		expect(h.tasks.ids.size).toBe(1);
		expect(
			await h.queue.claimNext({ ownerId: "offline-worker", leaseSeconds: 30 }),
		).not.toBeNull();
		expect(
			await h.queue.claimNext({ ownerId: "offline-worker", leaseSeconds: 30 }),
		).toBeNull();
	});
	test("same key is isolated per organization", async () => {
		const h = harness();
		const request = input();
		const a = await h.service.submit(request);
		const b = await h.serviceFor(otherScope).submit(request);
		if (!a.ok || !b.ok) throw new Error("Expected receipts");
		expect(a.value.task.id).not.toBe(b.value.task.id);
		expect(a.value.jobId).not.toBe(b.value.jobId);
	});
	test("reused key with changed payload conflicts before enqueue", async () => {
		const h = harness();
		const request = input();
		await h.service.submit(request);
		for (const patch of [
			{ branch: "task/different" },
			{ budget: { maxAgentTurns: 13 } },
			{ repositoryId: crypto.randomUUID() },
		])
			expect(await h.service.submit({ ...request, ...patch })).toMatchObject({
				ok: false,
				error: { code: "CONFLICT" },
			});
		expect(h.queue.calls).toHaveLength(1);
	});
	test("ownership checked before persistence", async () => {
		const h = harness();
		h.denyRepository();
		expect(await h.service.submit(input())).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(h.tasks.calls).toHaveLength(0);
		expect(h.queue.calls).toHaveLength(0);
	});
	test("cross-tenant task and queue rows are denied", async () => {
		const a = harness();
		a.tasks.corruptOwner = true;
		expect(await a.service.submit(input())).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(a.queue.calls).toHaveLength(0);
		const b = harness();
		b.queue.corruptOwner = true;
		expect(await b.service.submit(input())).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
	});
	test("queue failure is sanitized and same-key retry repairs partial fake write", async () => {
		const h = harness();
		const request = input();
		h.queue.fail = true;
		const failed = await h.service.submit(request);
		expect(failed).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
		expect(JSON.stringify(failed)).not.toContain("fake-secret");
		h.queue.fail = false;
		expect((await h.service.submit(request)).ok).toBe(true);
		expect(h.tasks.ids.size).toBe(1);
	});
	test("task failure never enqueues or exposes driver errors", async () => {
		const h = harness();
		h.tasks.fail = true;
		const failed = await h.service.submit(input());
		expect(failed).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
		expect(JSON.stringify(failed)).not.toContain("postgres:");
		expect(h.queue.calls).toHaveLength(0);
	});
	test("empty, scoped list and safe list failure", async () => {
		const h = harness();
		expect(await h.service.list({})).toEqual({ ok: true, value: [] });
		await h.service.submit(input());
		expect(await h.serviceFor(otherScope).list({})).toEqual({
			ok: true,
			value: [],
		});
		const result = await h.service.list({ limit: 1 });
		if (!result.ok) throw new Error("Expected list");
		expect(result.value).toHaveLength(1);
		h.failList();
		const failed = await h.service.list({});
		expect(failed).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
		expect(JSON.stringify(failed)).not.toContain("private");
	});
	test("auth failure never initializes storage", async () => {
		let stores = 0;
		const h = harness();
		const service = createTaskService({
			resolveScope: async () => {
				throw new ControlPlaneError("AUTH_REQUIRED");
			},
			getStore: async () => {
				stores++;
				return h.store;
			},
		});
		expect(await service.submit(input())).toMatchObject({
			ok: false,
			error: { code: "AUTH_REQUIRED" },
		});
		expect(await service.list({})).toMatchObject({
			ok: false,
			error: { code: "AUTH_REQUIRED" },
		});
		expect(stores).toBe(0);
	});
	test("malformed trusted identity fails closed", async () => {
		const h = harness();
		expect(
			await h
				.serviceFor({ ...scope, organizationId: asOrganizationId("invalid") })
				.list({}),
		).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
		expect(h.reads()).toBe(0);
	});
});
