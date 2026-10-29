import { describe, expect, test } from "bun:test";
import { createDevelopmentStore } from "./development-store.server";
import { type RuntimeConfig, resolveLocalScope } from "./local-mode.server";
import { ControlPlaneError, createTaskService } from "./task-service.server";
import { harness, input, otherScope, scope } from "./test-fixtures";

describe("input validation", () => {
	const invalid = {
		tenant: { organizationId: otherScope.organizationId },
		actor: { createdBy: otherScope.userId },
		repository: { repositoryId: "bad" },
		branch: { branch: "../main" },
		slash: { branch: "task//bad" },
		key: { idempotencyKey: "bad" },
		budget: { budget: { maxAgentTurns: 51 } },
		repair: { budget: { repairBudget: -1 } },
		timeout: { budget: { jobTimeoutMs: 999 } },
	};
	for (const [name, patch] of Object.entries(invalid))
		test(`rejects invalid/spoofed submission: ${name}`, async () => {
			const h = harness();
			expect(await h.service.submit({ ...input(), ...patch })).toMatchObject({
				ok: false,
				error: { code: "INVALID_INPUT" },
			});
			expect(h.reads()).toBe(0);
		});
	for (const limit of [0, 101, 1.5, "25", null])
		test(`rejects list limit ${String(limit)}`, async () => {
			const h = harness();
			expect(await h.service.list({ limit })).toMatchObject({
				ok: false,
				error: { code: "INVALID_INPUT" },
			});
			expect(h.reads()).toBe(0);
		});
	test("list rejects spoofed tenant", async () => {
		expect(
			await harness().service.list({
				organizationId: otherScope.organizationId,
			}),
		).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
	});
});
describe("explicit local-only fake policy", () => {
	const denied: RuntimeConfig[] = [
		{},
		{ nodeEnv: "production", localDemo: "true" },
		{ nodeEnv: "staging", localDemo: "true" },
		{ nodeEnv: "development" },
		{ nodeEnv: "test", localDemo: "false" },
		{
			nodeEnv: "test",
			localDemo: "true",
			databaseUrl: "postgres://unused-fixture",
		},
	];
	for (const config of denied)
		test(`deny ${JSON.stringify(config)}`, () => {
			expect(() => resolveLocalScope(config)).toThrow(ControlPlaneError);
			expect(() => createDevelopmentStore(config)).toThrow(ControlPlaneError);
		});
	for (const nodeEnv of ["development", "test"])
		test(`explicit ${nodeEnv} demo`, async () => {
			const config = { nodeEnv, localDemo: "true" };
			expect(resolveLocalScope(config)).toEqual(scope);
			const store = createDevelopmentStore(config);
			const service = createTaskService({
				resolveScope: async () => scope,
				getStore: async () => store,
			});
			const receipts = [];
			for (let n = 0; n < 4; n++) {
				const result = await service.submit(input());
				if (!result.ok) throw new Error("Expected task");
				expect(result.value.compilation.outcome).toBe("compiled");
				receipts.push(result.value.task);
			}
			const result = await service.list({ limit: 2 });
			if (!result.ok) throw new Error("Expected list");
			const expected = receipts
				.sort(
					(a, b) =>
						b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
				)
				.slice(0, 2);
			expect(result.value).toEqual(expected);
			expect(
				await service.submit(input({ repositoryId: crypto.randomUUID() })),
			).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
			expect(await store.listLatest(otherScope, 25)).toEqual([]);
		});
	test("local fixture compiles one plan and reuses it for later tasks", async () => {
		const config = { nodeEnv: "test", localDemo: "true" };
		const store = createDevelopmentStore(config);
		const service = createTaskService({
			resolveScope: async () => scope,
			getStore: async () => store,
		});
		const first = await service.submit(input());
		const second = await service.submit(input());
		if (!first.ok || !second.ok) throw new Error("Expected compiled receipts");
		expect(first.value.compilation.compiledPlanId).toBe(
			second.value.compilation.compiledPlanId,
		);
		expect(first.value.task.id).not.toBe(second.value.task.id);
		expect(
			await service.submit(
				input({ workflowDefinitionId: crypto.randomUUID() }),
			),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
	});
});
