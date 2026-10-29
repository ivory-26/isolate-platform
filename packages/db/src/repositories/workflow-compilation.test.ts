import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createInMemoryWorkflowCompilationRepositories } from "@isolate/db/testing";
import {
	PostgresCompiledPlanRepository,
	PostgresWorkflowRejectionRepository,
} from "../index";
import type { CompiledWorkflowPlan, WorkflowRejectionIssue } from "../schema";
import {
	compiledPlan,
	issue,
	otherOrg,
	pin,
	recordingSql,
} from "../testing/workflow-compilation-fixtures";
import { serializeWorkflowJson } from "./workflow-compilation";

function backends() {
	const { sql, calls } = recordingSql([]);
	return {
		calls,
		backends: [
			createInMemoryWorkflowCompilationRepositories({ versions: [pin] }),
			{
				compiledPlans: new PostgresCompiledPlanRepository(sql),
				rejections: new PostgresWorkflowRejectionRepository(sql),
			},
		],
	};
}

for (const version of [
	0,
	-1,
	1.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	2147483648,
]) {
	test(`both backends reject invalid PostgreSQL workflow version ${version} before SQL`, async () => {
		const { backends: stores, calls } = backends();
		for (const { compiledPlans, rejections } of stores) {
			const bad = { ...pin, workflowVersion: version };
			await expect(
				compiledPlans.save({
					...bad,
					plan: { ...compiledPlan(), versionPinned: version },
				}),
			).rejects.toThrow("workflowVersion");
			await expect(
				compiledPlans.get(
					pin.organizationId,
					pin.workflowDefinitionId,
					version,
				),
			).rejects.toThrow("workflowVersion");
			await expect(
				rejections.record({ ...bad, issues: [issue] }),
			).rejects.toThrow("workflowVersion");
			await expect(
				rejections.listLatest(
					pin.organizationId,
					pin.workflowDefinitionId,
					version,
				),
			).rejects.toThrow("workflowVersion");
		}
		expect(calls).toHaveLength(0);
	});
}

test("both backends reject empty scope and mismatched compiler pins", async () => {
	const { backends: stores, calls } = backends();
	for (const { compiledPlans, rejections } of stores) {
		for (const bad of [
			{ ...pin, organizationId: " " as typeof pin.organizationId },
			{ ...pin, workflowDefinitionId: "" as typeof pin.workflowDefinitionId },
		]) {
			await expect(
				compiledPlans.save({ ...bad, plan: compiledPlan() }),
			).rejects.toThrow("non-empty");
			await expect(
				compiledPlans.list(bad.organizationId, bad.workflowDefinitionId),
			).rejects.toThrow("non-empty");
			await expect(
				compiledPlans.listVersions(
					bad.organizationId,
					bad.workflowDefinitionId,
				),
			).rejects.toThrow("non-empty");
			await expect(
				rejections.record({ ...bad, issues: [issue] }),
			).rejects.toThrow("non-empty");
		}
		for (const plan of [
			{ ...compiledPlan(), workflowId: "another-definition" },
			{ ...compiledPlan(), versionPinned: 2 },
		]) {
			await expect(compiledPlans.save({ ...pin, plan })).rejects.toThrow(
				"must match",
			);
		}
	}
	expect(calls).toHaveLength(0);
});

test("both backends reject opaque plans and legacy/malformed rejection payloads", async () => {
	const { backends: stores, calls } = backends();
	for (const { compiledPlans, rejections } of stores) {
		for (const plan of [
			null,
			[],
			{},
			{ ...compiledPlan(), planId: "" },
			{ ...compiledPlan(), steps: null },
		]) {
			await expect(
				compiledPlans.save({ ...pin, plan: plan as CompiledWorkflowPlan }),
			).rejects.toThrow();
		}
		for (const issues of [
			null,
			[],
			[null],
			[{ code: "INVALID_TYPE", issue: "legacy message" }],
			[{ ...issue, path: undefined }],
			[{ ...issue, code: "" }],
			[{ ...issue, message: "" }],
		]) {
			await expect(
				rejections.record({
					...pin,
					issues: issues as WorkflowRejectionIssue[],
				}),
			).rejects.toThrow();
		}
	}
	expect(calls).toHaveLength(0);
});

for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 501]) {
	test(`both rejection backends reject invalid limit ${limit}`, async () => {
		const { backends: stores, calls } = backends();
		for (const { rejections } of stores)
			await expect(
				rejections.listLatest(
					pin.organizationId,
					pin.workflowDefinitionId,
					1,
					limit,
				),
			).rejects.toThrow("limit");
		expect(calls).toHaveLength(0);
	});
}

test("JSON persistence rejects lossy values and cycles but accepts shared JSON references", () => {
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	for (const value of [
		undefined,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		1n,
		() => 1,
		Symbol("bad"),
		new Date(),
		new Map(),
		cycle,
		{ nested: undefined },
		[undefined],
		{ [Symbol("bad")]: 1 },
	]) {
		expect(() => serializeWorkflowJson(value)).toThrow();
	}
	const shared = { valid: [null, true, 1, "text"] };
	expect(JSON.parse(serializeWorkflowJson({ a: shared, b: shared }))).toEqual({
		a: shared,
		b: shared,
	});
});

test("both plan backends reject lossy JSON before persistence", async () => {
	const { backends: stores, calls } = backends();
	for (const { compiledPlans } of stores) {
		const plan = { ...compiledPlan(), extra: { hidden: undefined } };
		await expect(compiledPlans.save({ ...pin, plan })).rejects.toThrow("JSON");
	}
	expect(calls).toHaveLength(0);
});

test("testing factory snapshots registered pins and rejects impossible tenant ownership", () => {
	expect(() =>
		createInMemoryWorkflowCompilationRepositories({
			versions: [pin, { ...pin, organizationId: otherOrg }],
		}),
	).toThrow("multiple organizations");
});

test("testing factories have no shared mutable state", async () => {
	const one = createInMemoryWorkflowCompilationRepositories({
		versions: [pin],
	});
	const two = createInMemoryWorkflowCompilationRepositories({
		versions: [pin],
	});
	await one.compiledPlans.save({ ...pin, plan: compiledPlan() });
	await one.rejections.record({ ...pin, issues: [issue] });
	expect(
		await two.compiledPlans.list(pin.organizationId, pin.workflowDefinitionId),
	).toEqual([]);
	expect(
		await two.rejections.listLatest(
			pin.organizationId,
			pin.workflowDefinitionId,
			1,
		),
	).toEqual([]);
});

test("0002 remains additive and compatible with the coordinator's line-based splitter", () => {
	const raw = readFileSync(
		new URL("../../migrations/0002_workflow_compilation.sql", import.meta.url),
		"utf8",
	);
	const statements: string[] = [];
	let current: string[] = [];
	for (const line of raw.split(String.fromCharCode(10))) {
		current.push(line);
		if (line.trimEnd().endsWith(";")) {
			const statement = current
				.filter((l) => !l.trimStart().startsWith("--"))
				.join(" ")
				.trim();
			if (statement.length > 0) statements.push(statement);
			current = [];
		}
	}
	expect(current.join("").trim()).toBe("");
	expect(statements).toHaveLength(4);
	for (const statement of statements)
		expect(statement).toMatch(
			/^CREATE (UNIQUE INDEX|TABLE|INDEX) IF NOT EXISTS /,
		);
	for (const fragment of [
		"FOREIGN KEY (organization_id, workflow_definition_id)",
		"REFERENCES workflow_versions (definition_id, version)",
		"workflow_version integer NOT NULL CHECK (workflow_version >= 1)",
	]) {
		expect(raw.split(fragment).length - 1).toBe(2);
	}
});
