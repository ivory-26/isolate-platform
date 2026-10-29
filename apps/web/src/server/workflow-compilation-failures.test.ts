import { describe, expect, test } from "bun:test";
import {
	budgetGraph,
	compilationHarness,
	compilationRequest,
	toolGraph,
	validGraph,
} from "./workflow-compilation-fixtures";

describe("unknown authored graph guard", () => {
	const malformed: unknown[] = [
		null,
		undefined,
		"private-source",
		[],
		{},
		{ ...validGraph(), nodes: null },
		{ ...validGraph(), nodes: [null] },
		{ ...validGraph(), nodes: [{}] },
		{ ...validGraph(), edges: [null] },
		{ ...validGraph(), edges: [{ from: "x", to: "y", when: null }] },
		{
			...validGraph(),
			nodes: [{ id: "a", type: "task.agent", label: "A", config: null }],
		},
	];
	for (const [index, graph] of malformed.entries()) {
		test(`malformed stored graph records a safe rejection ${index}`, async () => {
			const h = compilationHarness({ graph });
			const result = await h.service.compileAndPersist(compilationRequest);
			expect(result).toMatchObject({
				outcome: "rejected",
				issues: [{ code: "MALFORMED_GRAPH", path: "graph" }],
			});
			expect(await h.recorded()).toHaveLength(1);
			expect(await h.plan()).toBeNull();
			expect(h.events).not.toContain("save:start");
			expect(JSON.stringify(result)).not.toContain("private-source");
		});
	}
	test("stored getters and serialization hooks never execute", async () => {
		let invoked = 0;
		const getterGraph = validGraph();
		Object.defineProperty(getterGraph, "name", {
			enumerable: true,
			get() {
				invoked++;
				throw new Error("private source");
			},
		});
		const hookGraph = {
			...validGraph(),
			toJSON() {
				invoked++;
				throw new Error("private source");
			},
		};
		for (const graph of [getterGraph, hookGraph])
			expect(
				await compilationHarness({ graph }).service.compileAndPersist(
					compilationRequest,
				),
			).toMatchObject({
				outcome: "rejected",
				issues: [{ code: "MALFORMED_GRAPH" }],
			});
		expect(invoked).toBe(0);
	});
	test("stored proxy traps and cyclic values are refused without executing source", async () => {
		let invoked = 0;
		const proxy = new Proxy(validGraph(), {
			get() {
				invoked++;
				throw new Error("private");
			},
			ownKeys() {
				invoked++;
				throw new Error("private");
			},
		});
		const cyclic = validGraph();
		cyclic.nodes[0].config.self = cyclic;
		for (const graph of [proxy, cyclic])
			expect(
				await compilationHarness({ graph }).service.compileAndPersist(
					compilationRequest,
				),
			).toMatchObject({
				outcome: "rejected",
				issues: [{ code: "MALFORMED_GRAPH" }],
			});
		expect(invoked).toBe(0);
	});
});

describe("trusted server policy", () => {
	test("tools denied by default and by a nonmatching server allowlist", async () => {
		for (const toolAllowlist of [[], ["different.tool"]]) {
			const h = compilationHarness({
				graph: toolGraph("PRIVATE_CREDENTIAL_TOOL"),
			});
			h.state.policy = { toolAllowlist, taskBudget: 3 };
			const result = await h.service.compileAndPersist(compilationRequest);
			expect(result).toMatchObject({
				outcome: "rejected",
				issues: [{ code: "UNAUTHORIZED_TOOL" }],
			});
			expect(await h.plan()).toBeNull();
			expect(await h.recorded()).toHaveLength(1);
			expect(JSON.stringify(result)).not.toContain("PRIVATE_CREDENTIAL_TOOL");
		}
	});
	test("only the trusted policy can allow a tool", async () => {
		const h = compilationHarness({ graph: toolGraph() });
		h.state.policy = { toolAllowlist: ["repo.read"], taskBudget: 3 };
		expect(await h.service.compileAndPersist(compilationRequest)).toMatchObject(
			{ outcome: "compiled" },
		);
		expect((await h.plan())?.plan.steps[0].config).toEqual({
			tool: "repo.read",
		});
	});
	test("compiler enforces the server task budget; sufficient budget compiles", async () => {
		const denied = compilationHarness({ graph: budgetGraph() });
		const result = await denied.service.compileAndPersist(compilationRequest);
		expect(result).toMatchObject({
			outcome: "rejected",
			issues: [{ code: "INVALID_TYPE", path: "nodes[0].config.maxAttempts" }],
		});
		expect(await denied.plan()).toBeNull();
		const allowed = compilationHarness({ graph: budgetGraph() });
		allowed.state.policy = { toolAllowlist: [], taskBudget: 4 };
		expect(
			await allowed.service.compileAndPersist(compilationRequest),
		).toMatchObject({ outcome: "compiled" });
	});
	for (const taskBudget of [0, -1, 1.2, 2147483648, NaN, Infinity])
		test(`invalid server policy fails closed before DB: ${String(taskBudget)}`, async () => {
			const h = compilationHarness();
			h.state.policy = { toolAllowlist: [], taskBudget };
			expect(
				await h.service.compileAndPersist(compilationRequest),
			).toMatchObject({
				outcome: "error",
				error: { code: "POLICY_UNAVAILABLE" },
			});
			expect(h.events).toEqual(["scope", "membership", "policy"]);
		});
	test("policy denial or resolver failure never initializes storage", async () => {
		const denied = compilationHarness();
		denied.state.policy = null;
		expect(
			await denied.service.compileAndPersist(compilationRequest),
		).toMatchObject({ outcome: "error", error: { code: "FORBIDDEN" } });
		expect(denied.events).not.toContain("repositories");
		const failed = compilationHarness();
		failed.state.policyThrows = true;
		const result = await failed.service.compileAndPersist(compilationRequest);
		expect(result).toMatchObject({
			outcome: "error",
			error: { code: "POLICY_UNAVAILABLE" },
		});
		expect(failed.events).not.toContain("repositories");
		expect(JSON.stringify(result)).not.toContain("fixture-credential");
	});
});

describe("persistence failures never masquerade as compilation success", () => {
	for (const phase of [
		"initThrows",
		"readerThrows",
		"planThrows",
		"rejectionThrows",
	] as const)
		test(`explicit safe storage failure: ${phase}`, async () => {
			const h = compilationHarness(
				phase === "rejectionThrows" ? { graph: null } : {},
			);
			h.state[phase] = true;
			const result = await h.service.compileAndPersist(compilationRequest);
			expect(result).toMatchObject({
				outcome: "error",
				error: { code: "STORAGE_FAILURE" },
			});
			expect(JSON.stringify(result)).not.toContain("fixture-credential");
			expect(await h.plan()).toBeNull();
			expect(await h.recorded()).toEqual([]);
		});
	for (const graph of [validGraph(), null])
		test(`disappearing persistence version returns NOT_FOUND for ${graph ? "plan" : "rejection"}`, async () => {
			const h = compilationHarness({ graph, missingPersistencePin: true });
			expect(
				await h.service.compileAndPersist(compilationRequest),
			).toMatchObject({ outcome: "error", error: { code: "NOT_FOUND" } });
			expect(await h.plan()).toBeNull();
			expect(await h.recorded()).toEqual([]);
		});
});
