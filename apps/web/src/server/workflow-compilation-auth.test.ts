import { describe, expect, test } from "bun:test";
import { asOrganizationId, asWorkflowDefinitionId } from "@isolate/shared";
import {
	compilationHarness,
	compilationRequest,
	compilationScope,
} from "./workflow-compilation-fixtures";

describe("compilation authorization and unknown request boundary", () => {
	const invalid: unknown[] = [
		null,
		undefined,
		[],
		"graph",
		{},
		{ ...compilationRequest, workflowDefinitionId: "bad" },
		{ ...compilationRequest, workflowDefinitionId: 3 },
	];
	for (const workflowVersion of [
		0,
		-1,
		1.5,
		2147483648,
		NaN,
		Infinity,
		"2",
		null,
		2n,
	])
		invalid.push({ ...compilationRequest, workflowVersion });
	for (const extra of [
		{ organizationId: "foreign" },
		{ tenant: "foreign" },
		{ graph: {} },
		{ toolAllowlist: ["dangerous"] },
		{ taskBudget: 999 },
		{ policy: { toolAllowlist: ["dangerous"], taskBudget: 999 } },
		{ userId: "spoofed" },
	])
		invalid.push({ ...compilationRequest, ...extra });
	for (const [index, request] of invalid.entries()) {
		test(`rejects unknown/malformed/spoofed request ${index}`, async () => {
			const h = compilationHarness();
			expect(await h.service.compileAndPersist(request)).toMatchObject({
				outcome: "error",
				error: { code: "INVALID_INPUT" },
			});
			expect(h.events).toEqual([]);
			expect(await h.plan()).toBeNull();
			expect(await h.recorded()).toEqual([]);
		});
	}
	test("maximum PostgreSQL integer is accepted and looked up exactly", async () => {
		const h = compilationHarness();
		expect(
			await h.service.compileAndPersist({
				...compilationRequest,
				workflowVersion: 2147483647,
			}),
		).toMatchObject({ outcome: "error", error: { code: "NOT_FOUND" } });
		expect(h.reads[0][2]).toBe(2147483647);
	});
	for (const mode of ["missing", "throws", "invalid"] as const)
		test(`scope denial before all database access: ${mode}`, async () => {
			const h = compilationHarness();
			if (mode === "missing") h.state.scope = null;
			if (mode === "throws") h.state.scopeThrows = true;
			if (mode === "invalid")
				h.state.scope = {
					...compilationScope,
					organizationId: asOrganizationId("not-a-uuid"),
				};
			expect(
				await h.service.compileAndPersist(compilationRequest),
			).toMatchObject({ outcome: "error", error: { code: "AUTH_REQUIRED" } });
			expect(h.events).toEqual(["scope"]);
		});
	for (const throws of [false, true])
		test(`membership denial before policy or repositories ${String(throws)}`, async () => {
			const h = compilationHarness();
			h.state.membership = false;
			h.state.membershipThrows = throws;
			expect(
				await h.service.compileAndPersist(compilationRequest),
			).toMatchObject({ outcome: "error", error: { code: "FORBIDDEN" } });
			expect(h.events).toEqual(["scope", "membership"]);
		});
	test("tenant cannot read or compile another organization's authored version", async () => {
		const h = compilationHarness();
		if (!h.state.scope) throw new Error("Expected fixture scope");
		h.state.scope = {
			...h.state.scope,
			organizationId: asOrganizationId("b1000000-0000-4000-8000-000000000001"),
		};
		expect(await h.service.compileAndPersist(compilationRequest)).toMatchObject(
			{ outcome: "error", error: { code: "NOT_FOUND" } },
		);
		expect(h.events).not.toContain("save:start");
		expect(h.events).not.toContain("record:start");
		expect(await h.plan()).toBeNull();
		expect(await h.recorded()).toEqual([]);
	});
	test("missing authored version is explicit NOT_FOUND, never an invented graph", async () => {
		const h = compilationHarness();
		h.rows.clear();
		expect(await h.service.compileAndPersist(compilationRequest)).toMatchObject(
			{ outcome: "error", error: { code: "NOT_FOUND" } },
		);
		expect(h.events).not.toContain("save:start");
		expect(h.events).not.toContain("record:start");
	});
	for (const field of ["definition_id", "version"] as const)
		test(`mis-pinned authored reader result is not persisted: ${field}`, async () => {
			const h = compilationHarness();
			if (field === "definition_id")
				h.row.definition_id = asWorkflowDefinitionId(
					"b1000000-0000-4000-8000-000000000003",
				);
			else h.row.version = 3;
			expect(
				await h.service.compileAndPersist(compilationRequest),
			).toMatchObject({ outcome: "error", error: { code: "NOT_FOUND" } });
			expect(h.events).not.toContain("save:start");
			expect(h.events).not.toContain("record:start");
		});
});
