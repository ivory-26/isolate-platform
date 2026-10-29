import { expect, test } from "bun:test";
import type { OrganizationId, WorkflowDefinitionId } from "@isolate/shared";
import {
	PostgresWorkflowVersionRepository,
	type WorkflowVersionRepository,
	type WorkflowVersionRow,
} from "../index";
import {
	otherDefinition,
	otherOrg,
	pin,
	recordingSql,
} from "../testing/workflow-compilation-fixtures";

const graph = {
	id: pin.workflowDefinitionId,
	version: 1,
	nodes: [],
	edges: [],
};
const legacyCompiled = { legacy: true, steps: [] };

function authoredRow(): WorkflowVersionRow {
	return {
		id: "40000000-0000-4000-8000-000000000001" as WorkflowVersionRow["id"],
		definition_id: pin.workflowDefinitionId,
		version: 1,
		graph,
		compiled: legacyCompiled,
		created_by:
			"50000000-0000-4000-8000-000000000001" as WorkflowVersionRow["created_by"],
		created_at: new Date("2026-10-29T00:00:00Z"),
	};
}

test("public authored-version reader uses one fully qualified tenant/definition/exact-version SELECT", async () => {
	const row = authoredRow();
	const { sql, calls } = recordingSql([[row]]);
	const repo: WorkflowVersionRepository = new PostgresWorkflowVersionRepository(
		sql,
	);
	expect(
		await repo.getAuthoredVersion(
			pin.organizationId,
			pin.workflowDefinitionId,
			1,
		),
	).toEqual(row);
	expect(calls).toHaveLength(1);
	expect(calls[0].params).toEqual([
		pin.organizationId,
		pin.workflowDefinitionId,
		1,
	]);
	const statement = calls[0].statement.replace(/\s+/g, " ").trim();
	expect(statement).toBe(
		"SELECT v.id, v.definition_id, v.version, v.graph, v.compiled, v.created_by, v.created_at FROM workflow_versions v JOIN workflow_definitions d ON d.id = v.definition_id WHERE d.organization_id = $1 AND v.definition_id = $2 AND v.version = $3",
	);
	expect(statement).not.toContain(pin.organizationId);
	expect(statement).not.toContain(pin.workflowDefinitionId);
});

for (const rawGraph of [false, true]) {
	for (const [label, compiled, expected] of [
		["decoded object", legacyCompiled, legacyCompiled],
		["raw JSON string", JSON.stringify(legacyCompiled), legacyCompiled],
		["SQL null", null, null],
		["JSON null", "null", null],
	] as const) {
		test(`authored-version mapper: graph raw=${rawGraph}, compiled=${label}`, async () => {
			const row = authoredRow();
			const { sql, calls } = recordingSql([
				[{ ...row, graph: rawGraph ? JSON.stringify(graph) : graph, compiled }],
			]);
			const result = await new PostgresWorkflowVersionRepository(
				sql,
			).getAuthoredVersion(pin.organizationId, pin.workflowDefinitionId, 1);
			expect(result).toEqual({ ...row, compiled: expected });
			expect(result?.created_at).toBeInstanceOf(Date);
			expect(result?.created_at).toBe(row.created_at);
			expect(calls).toHaveLength(1);
		});
	}
}

test("absent, foreign-tenant, different-definition and missing-version pins all return null without fallback", async () => {
	const { sql, calls } = recordingSql([[], [], [], []]);
	const repo = new PostgresWorkflowVersionRepository(sql);
	const pins = [
		pin,
		{ ...pin, organizationId: otherOrg },
		{ ...pin, workflowDefinitionId: otherDefinition },
		{ ...pin, workflowVersion: 2 },
	];
	for (const requested of pins) {
		expect(
			await repo.getAuthoredVersion(
				requested.organizationId,
				requested.workflowDefinitionId,
				requested.workflowVersion,
			),
		).toBeNull();
	}
	expect(calls).toHaveLength(pins.length);
	for (let index = 0; index < pins.length; index++) {
		expect(calls[index].params).toEqual([
			pins[index].organizationId,
			pins[index].workflowDefinitionId,
			pins[index].workflowVersion,
		]);
		expect(calls[index].statement).toBe(calls[0].statement);
	}
});

for (const field of ["organizationId", "workflowDefinitionId"] as const) {
	test(`invalid ${field} returns null without issuing SQL`, async () => {
		const { sql, calls } = recordingSql([]);
		const repo = new PostgresWorkflowVersionRepository(sql);
		for (const value of [
			"",
			"  ",
			String.fromCharCode(9, 10),
			null,
			undefined,
			42,
			{},
		]) {
			const organizationId =
				field === "organizationId"
					? (value as OrganizationId)
					: pin.organizationId;
			const workflowDefinitionId =
				field === "workflowDefinitionId"
					? (value as WorkflowDefinitionId)
					: pin.workflowDefinitionId;
			expect(
				await repo.getAuthoredVersion(organizationId, workflowDefinitionId, 1),
			).toBeNull();
		}
		expect(calls).toHaveLength(0);
	});
}

for (const version of [
	0,
	-1,
	1.5,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	2147483648,
	Number.MAX_SAFE_INTEGER,
	null,
	undefined,
	"1",
]) {
	test(`invalid authored version ${String(version)} returns null before SQL`, async () => {
		const { sql, calls } = recordingSql([]);
		const repo = new PostgresWorkflowVersionRepository(sql);
		expect(
			await repo.getAuthoredVersion(
				pin.organizationId,
				pin.workflowDefinitionId,
				version as number,
			),
		).toBeNull();
		expect(calls).toHaveLength(0);
	});
}

test("maximum PostgreSQL integer is queried as the exact pin, with no latest fallback", async () => {
	const row = { ...authoredRow(), version: 2147483647 };
	const { sql, calls } = recordingSql([[row]]);
	const repo = new PostgresWorkflowVersionRepository(sql);
	expect(
		(
			await repo.getAuthoredVersion(
				pin.organizationId,
				pin.workflowDefinitionId,
				2147483647,
			)
		)?.version,
	).toBe(2147483647);
	expect(calls).toHaveLength(1);
	expect(calls[0].params).toEqual([
		pin.organizationId,
		pin.workflowDefinitionId,
		2147483647,
	]);
});

test("authored graph is read as unknown data without validating or recompiling it", async () => {
	const row = {
		...authoredRow(),
		graph: JSON.stringify([null, false, "unvalidated authored data"]),
		compiled: null,
	};
	const { sql, calls } = recordingSql([[row]]);
	const result = await new PostgresWorkflowVersionRepository(
		sql,
	).getAuthoredVersion(pin.organizationId, pin.workflowDefinitionId, 1);
	expect(result?.graph).toEqual([null, false, "unvalidated authored data"]);
	expect(result?.compiled).toBeNull();
	expect(calls).toHaveLength(1);
});

test("unexpected SQL errors are not swallowed as absent pins", async () => {
	const { sql, calls } = recordingSql([]);
	await expect(
		new PostgresWorkflowVersionRepository(sql).getAuthoredVersion(
			pin.organizationId,
			pin.workflowDefinitionId,
			1,
		),
	).rejects.toThrow("unexpected SQL call");
	expect(calls).toHaveLength(1);
});

test("invalid stored JSON propagates a decode error rather than a missing-pin result", async () => {
	const { sql, calls } = recordingSql([
		[{ ...authoredRow(), graph: "not JSON" }],
	]);
	await expect(
		new PostgresWorkflowVersionRepository(sql).getAuthoredVersion(
			pin.organizationId,
			pin.workflowDefinitionId,
			1,
		),
	).rejects.toBeInstanceOf(SyntaxError);
	expect(calls).toHaveLength(1);
});
