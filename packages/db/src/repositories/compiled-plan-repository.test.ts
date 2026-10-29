import { expect, test } from "bun:test";
import {
	createInMemoryWorkflowCompilationRepositories,
	InMemoryCompiledPlanRepository,
} from "../testing";
import {
	compiledPlan,
	otherDefinition,
	otherOrg,
	pin,
	planRow,
	recordingSql,
} from "../testing/workflow-compilation-fixtures";
import {
	evaluatePlanSaveOutcome,
	PostgresCompiledPlanRepository,
} from "./compiled-plan-repository";

for (const versionExists of [false, true]) {
	for (const alreadySaved of [false, true]) {
		test(`save decision: version=${versionExists}, existing=${alreadySaved}`, () => {
			expect(evaluatePlanSaveOutcome({ versionExists, alreadySaved })).toEqual(
				!versionExists
					? { ok: false, code: "NOT_FOUND" }
					: alreadySaved
						? { ok: false, code: "CONFLICT" }
						: { ok: true },
			);
		});
	}
}

test("compiled plans: real compiler output round-trips; duplicate and competing saves conflict", async () => {
	const repo = new InMemoryCompiledPlanRepository({ versions: [pin] });
	const input = { ...pin, plan: compiledPlan() };
	const results = await Promise.all([
		repo.save(input),
		repo.save(input),
		repo.save({ ...input, plan: { ...input.plan, planId: "replacement" } }),
	]);
	expect(results.filter((r) => r.ok)).toHaveLength(1);
	expect(results.filter((r) => !r.ok)).toEqual([
		{ ok: false, code: "CONFLICT" },
		{ ok: false, code: "CONFLICT" },
	]);
	expect(
		(await repo.get(pin.organizationId, pin.workflowDefinitionId, 1))?.plan,
	).toEqual(input.plan);
});

test("compiled plans: tenant isolation and nonexistent versions fail closed", async () => {
	const repo = new InMemoryCompiledPlanRepository({
		versions: [
			pin,
			{
				...pin,
				organizationId: otherOrg,
				workflowDefinitionId: otherDefinition,
			},
		],
	});
	await repo.save({ ...pin, plan: compiledPlan() });
	for (const absent of [
		{ ...pin, organizationId: otherOrg },
		{ ...pin, workflowDefinitionId: otherDefinition },
		{ ...pin, workflowVersion: 2 },
	]) {
		expect(await repo.save({ ...absent, plan: compiledPlan(absent) })).toEqual({
			ok: false,
			code: "NOT_FOUND",
		});
		expect(
			await repo.get(
				absent.organizationId,
				absent.workflowDefinitionId,
				absent.workflowVersion,
			),
		).toBeNull();
	}
	expect(await repo.list(otherOrg, pin.workflowDefinitionId)).toEqual([]);
	expect(await repo.listVersions(otherOrg, pin.workflowDefinitionId)).toEqual(
		[],
	);
	const own = {
		...pin,
		organizationId: otherOrg,
		workflowDefinitionId: otherDefinition,
	};
	expect((await repo.save({ ...own, plan: compiledPlan(own) })).ok).toBe(true);
	expect(await repo.list(pin.organizationId, otherDefinition)).toEqual([]);
});

test("compiled plans: all returned JSON, arrays and dates are detached from immutable state", async () => {
	const versions = [{ ...pin }];
	const repo = new InMemoryCompiledPlanRepository({ versions });
	versions[0].organizationId = otherOrg;
	const plan = compiledPlan();
	const original = structuredClone(plan);
	const saved = await repo.save({ ...pin, plan });
	if (!saved.ok) throw new Error("save failed");
	plan.steps[0].config = { tool: "mutated-input" };
	saved.plan.plan.entryNodeIds.push("mutated-output");
	saved.plan.created_at.setTime(0);
	const read = await repo.get(pin.organizationId, pin.workflowDefinitionId, 1);
	if (!read) throw new Error("missing plan");
	read.plan.steps[0].nodeId = "mutated-get";
	const listed = await repo.list(pin.organizationId, pin.workflowDefinitionId);
	listed[0].plan.steps.length = 0;
	listed[0].created_at.setTime(0);
	const summaries = await repo.listVersions(
		pin.organizationId,
		pin.workflowDefinitionId,
	);
	summaries[0].created_at.setTime(0);
	const reread = await repo.get(
		pin.organizationId,
		pin.workflowDefinitionId,
		1,
	);
	expect(reread?.plan).toEqual(original);
	expect(reread?.created_at.getTime()).not.toBe(0);
});

test("compiled plans: versions list numerically descending and omit blobs in summaries", async () => {
	const versions = [1, 2, 10].map((workflowVersion) => ({
		...pin,
		workflowVersion,
	}));
	const { compiledPlans: repo } = createInMemoryWorkflowCompilationRepositories(
		{ versions },
	);
	for (const version of versions)
		await repo.save({ ...version, plan: compiledPlan(version) });
	expect(
		(await repo.list(pin.organizationId, pin.workflowDefinitionId)).map(
			(r) => r.workflow_version,
		),
	).toEqual([10, 2, 1]);
	const summaries = await repo.listVersions(
		pin.organizationId,
		pin.workflowDefinitionId,
	);
	expect(summaries.map((r) => r.workflow_version)).toEqual([10, 2, 1]);
	expect(summaries.every((r) => !("plan" in r))).toBe(true);
	expect(
		await new InMemoryCompiledPlanRepository().save({
			...pin,
			plan: compiledPlan(),
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
});

for (const rawJson of [false, true]) {
	test(`Postgres compiled plan mapper normalizes jsonb strings=${rawJson} on save/get/list`, async () => {
		const row = planRow();
		const dbRow = {
			...row,
			plan: rawJson ? JSON.stringify(row.plan) : row.plan,
		};
		const { sql, calls } = recordingSql([[dbRow], [dbRow], [dbRow], [row]]);
		const repo = new PostgresCompiledPlanRepository(sql);
		expect(await repo.save({ ...pin, plan: row.plan })).toEqual({
			ok: true,
			plan: row,
		});
		expect(
			await repo.get(pin.organizationId, pin.workflowDefinitionId, 1),
		).toEqual(row);
		expect(
			await repo.list(pin.organizationId, pin.workflowDefinitionId),
		).toEqual([row]);
		expect(
			await repo.listVersions(pin.organizationId, pin.workflowDefinitionId),
		).toEqual([
			{ id: row.id, workflow_version: 1, created_at: row.created_at },
		]);
		expect(calls[0].params).toEqual([
			pin.organizationId,
			pin.workflowDefinitionId,
			1,
			JSON.stringify(row.plan),
		]);
		expect(calls[0].statement).toContain("DO NOTHING");
		expect(calls[0].statement).not.toContain("DO UPDATE");
		for (const call of calls) {
			expect(call.statement).toContain("organization_id = $1");
			expect(call.params.slice(0, 2)).toEqual([
				pin.organizationId,
				pin.workflowDefinitionId,
			]);
		}
	});
}

for (const exists of [false, true]) {
	test(`Postgres no-row insert classifies scoped existence=${exists}`, async () => {
		const { sql, calls } = recordingSql([
			[],
			exists ? [{ id: "version" }] : [],
		]);
		expect(
			await new PostgresCompiledPlanRepository(sql).save({
				...pin,
				plan: compiledPlan(),
			}),
		).toEqual({ ok: false, code: exists ? "CONFLICT" : "NOT_FOUND" });
		expect(calls[1].statement).toContain("d.organization_id = $1");
		expect(calls[1].params).toEqual([
			pin.organizationId,
			pin.workflowDefinitionId,
			1,
		]);
	});
}

test("Postgres compiled plan missing reads are null/empty", async () => {
	const { sql } = recordingSql([[], [], []]);
	const repo = new PostgresCompiledPlanRepository(sql);
	expect(await repo.get(otherOrg, pin.workflowDefinitionId, 1)).toBeNull();
	expect(await repo.list(otherOrg, pin.workflowDefinitionId)).toEqual([]);
	expect(await repo.listVersions(otherOrg, pin.workflowDefinitionId)).toEqual(
		[],
	);
});
