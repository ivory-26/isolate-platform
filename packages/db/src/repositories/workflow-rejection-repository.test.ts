import { expect, test } from "bun:test";
import {
	createInMemoryWorkflowCompilationRepositories,
	InMemoryWorkflowRejectionRepository,
} from "../testing";
import {
	compiledPlan,
	issue,
	otherDefinition,
	otherOrg,
	pin,
	planRow,
	recordingSql,
} from "../testing/workflow-compilation-fixtures";
import { evaluateWorkflowVersion } from "./workflow-compilation";
import { PostgresWorkflowRejectionRepository } from "./workflow-rejection-repository";

test("rejection decision: unregistered version is NOT_FOUND", () => {
	expect(evaluateWorkflowVersion(false)).toEqual({
		ok: false,
		code: "NOT_FOUND",
	});
	expect(evaluateWorkflowVersion(true)).toEqual({ ok: true });
});

test("rejections append distinct records without replacing prior history or compiled plans", async () => {
	const { rejections, compiledPlans } =
		createInMemoryWorkflowCompilationRepositories({ versions: [pin] });
	const plan = compiledPlan();
	await compiledPlans.save({ ...pin, plan });
	const first = await rejections.record({ ...pin, issues: [issue] });
	const second = await rejections.record({
		...pin,
		issues: [{ ...issue, message: "another rejection" }],
	});
	if (!first.ok || !second.ok) throw new Error("record failed");
	expect(first.rejection.id).not.toBe(second.rejection.id);
	expect(
		await rejections.listLatest(
			pin.organizationId,
			pin.workflowDefinitionId,
			1,
		),
	).toHaveLength(2);
	expect(
		(await compiledPlans.get(pin.organizationId, pin.workflowDefinitionId, 1))
			?.plan,
	).toEqual(plan);
});

test("rejections: cross-tenant, cross-definition and nonexistent version isolation", async () => {
	const repo = new InMemoryWorkflowRejectionRepository({ versions: [pin] });
	await repo.record({ ...pin, issues: [issue] });
	for (const absent of [
		{ ...pin, organizationId: otherOrg },
		{ ...pin, workflowDefinitionId: otherDefinition },
		{ ...pin, workflowVersion: 2 },
	]) {
		expect(await repo.record({ ...absent, issues: [issue] })).toEqual({
			ok: false,
			code: "NOT_FOUND",
		});
		expect(
			await repo.listLatest(
				absent.organizationId,
				absent.workflowDefinitionId,
				absent.workflowVersion,
			),
		).toEqual([]);
	}
});

test("rejections: newest-first limit and deterministic id tie-break match SQL", async () => {
	let now = 1000;
	const repo = new InMemoryWorkflowRejectionRepository({
		versions: [pin, { ...pin, workflowVersion: 2 }],
		now: () => new Date(now),
	});
	for (const message of ["first", "second", "third"]) {
		await repo.record({ ...pin, issues: [{ ...issue, message }] });
		now += 1000;
	}
	await repo.record({ ...pin, workflowVersion: 2, issues: [issue] });
	expect(
		(
			await repo.listLatest(pin.organizationId, pin.workflowDefinitionId, 1, 2)
		).map((r) => r.issues[0].message),
	).toEqual(["third", "second"]);
	const tied = new InMemoryWorkflowRejectionRepository({
		versions: [pin],
		now: () => new Date(0),
	});
	for (let i = 0; i < 4; i++) await tied.record({ ...pin, issues: [issue] });
	const ids = (
		await tied.listLatest(pin.organizationId, pin.workflowDefinitionId, 1)
	).map((r) => r.id);
	expect(ids).toEqual([...ids].sort().reverse());
});

test("rejections: input/output JSON and dates cannot mutate append-only state", async () => {
	const issues = [{ ...issue }];
	const repo = new InMemoryWorkflowRejectionRepository({ versions: [pin] });
	const saved = await repo.record({ ...pin, issues });
	if (!saved.ok) throw new Error("record failed");
	issues[0].message = "changed input";
	saved.rejection.issues[0].path = "changed output";
	saved.rejection.created_at.setTime(0);
	const listed = await repo.listLatest(
		pin.organizationId,
		pin.workflowDefinitionId,
		1,
	);
	listed[0].issues.length = 0;
	listed[0].created_at.setTime(0);
	const reread = await repo.listLatest(
		pin.organizationId,
		pin.workflowDefinitionId,
		1,
	);
	expect(reread[0].issues).toEqual([issue]);
	expect(reread[0].created_at.getTime()).not.toBe(0);
});

for (const rawJson of [false, true]) {
	test(`Postgres rejection mapper normalizes jsonb strings=${rawJson}`, async () => {
		const { plan: _plan, ...base } = planRow();
		const row = { ...base, issues: [issue] };
		const dbRow = {
			...row,
			issues: rawJson ? JSON.stringify(row.issues) : row.issues,
		};
		const { sql, calls } = recordingSql([[dbRow], [dbRow]]);
		const repo = new PostgresWorkflowRejectionRepository(sql);
		expect(await repo.record({ ...pin, issues: [issue] })).toEqual({
			ok: true,
			rejection: row,
		});
		expect(
			await repo.listLatest(pin.organizationId, pin.workflowDefinitionId, 1, 3),
		).toEqual([row]);
		expect(calls[0].params).toEqual([
			pin.organizationId,
			pin.workflowDefinitionId,
			1,
			JSON.stringify([issue]),
		]);
		expect(calls[1].params).toEqual([
			pin.organizationId,
			pin.workflowDefinitionId,
			1,
			3,
		]);
		expect(calls[1].statement).toContain(
			"ORDER BY created_at DESC, id DESC LIMIT $4",
		);
		for (const call of calls)
			expect(call.statement).toContain("organization_id = $1");
		expect(calls[0].statement).toContain("v.version = $3");
	});
}

test("Postgres unknown/foreign rejection pin is NOT_FOUND; empty list stays empty", async () => {
	const { sql } = recordingSql([[], []]);
	const repo = new PostgresWorkflowRejectionRepository(sql);
	expect(
		await repo.record({ ...pin, organizationId: otherOrg, issues: [issue] }),
	).toEqual({ ok: false, code: "NOT_FOUND" });
	expect(await repo.listLatest(otherOrg, pin.workflowDefinitionId, 1)).toEqual(
		[],
	);
});

test("rejection default limit is bounded at 50", async () => {
	const { sql, calls } = recordingSql([[]]);
	await new PostgresWorkflowRejectionRepository(sql).listLatest(
		pin.organizationId,
		pin.workflowDefinitionId,
		1,
	);
	expect(calls[0].params[3]).toBe(50);
});
