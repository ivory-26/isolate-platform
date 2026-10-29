import { describe, expect, test } from "bun:test";
import {
	compilationHarness,
	compilationPin,
	compilationRequest,
	toolGraph,
	validGraph,
} from "./workflow-compilation-fixtures";

describe("actual compiler + W3 in-memory compilation persistence", () => {
	test("compiles the exact authored tenant/version and persists the canonical plan", async () => {
		const h = compilationHarness();
		const original = structuredClone(h.row);
		const result = await h.service.compileAndPersist(compilationRequest);
		expect(result).toMatchObject({ outcome: "compiled", pin: compilationPin });
		expect(h.events).toEqual([
			"scope",
			"membership",
			"policy",
			"repositories",
			"read",
			"save:start",
			"save:end",
		]);
		expect(h.reads).toEqual([
			[compilationPin.organizationId, compilationPin.workflowDefinitionId, 2],
		]);
		expect(h.policyPins).toEqual([compilationPin]);
		const plan = await h.plan();
		expect(plan?.plan).toMatchObject({
			workflowId: compilationPin.workflowDefinitionId,
			versionPinned: 2,
			entryNodeIds: ["agent-step"],
			steps: [
				{
					nodeId: "agent-step",
					type: "task.agent",
					order: 0,
					config: {
						agentId: "coding-agent",
						promptTemplateId: "stored-template",
					},
				},
			],
		});
		if (result.outcome !== "compiled")
			throw new Error("Expected compiled metadata");
		if (!plan) throw new Error("Expected persisted plan");
		expect(result.compiledPlanId).toBe(plan.id);
		expect(Object.keys(result).sort()).toEqual(
			["outcome", "pin", "compiledPlanId"].sort(),
		);
		expect(await h.recorded()).toEqual([]);
		expect(h.row).toEqual(original);
		expect(h.newerRow.compiled).toEqual({ legacy: "untouched" });
	});
	test("normalizes request UUID case, not the authored graph pin", async () => {
		const h = compilationHarness();
		expect(
			await h.service.compileAndPersist({
				...compilationRequest,
				workflowDefinitionId:
					compilationRequest.workflowDefinitionId.toUpperCase(),
			}),
		).toMatchObject({ outcome: "compiled", pin: compilationPin });
	});
	test("same version is immutable: second compile conflicts, never rejects or overwrites", async () => {
		const h = compilationHarness();
		expect(
			(await h.service.compileAndPersist(compilationRequest)).outcome,
		).toBe("compiled");
		const before = await h.plan();
		expect(await h.service.compileAndPersist(compilationRequest)).toEqual({
			outcome: "conflict",
			pin: compilationPin,
		});
		expect(await h.plan()).toEqual(before);
		expect(await h.recorded()).toEqual([]);
	});
	test("parallel duplicate compiles have one successful immutable save", async () => {
		const h = compilationHarness();
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				h.service.compileAndPersist(compilationRequest),
			),
		);
		expect(results.filter((r) => r.outcome === "compiled")).toHaveLength(1);
		expect(results.filter((r) => r.outcome === "conflict")).toHaveLength(7);
		expect(
			await h.compiledPlans.list(
				compilationPin.organizationId,
				compilationPin.workflowDefinitionId,
			),
		).toHaveLength(1);
		expect(await h.recorded()).toEqual([]);
	});
	test("dotted node ID is rejected by actual compiler, not rewritten", async () => {
		const graph = validGraph();
		graph.nodes[0].id = "private.source.step";
		const original = structuredClone(graph);
		const h = compilationHarness({ graph });
		const result = await h.service.compileAndPersist(compilationRequest);
		expect(result).toMatchObject({
			outcome: "rejected",
			pin: compilationPin,
			issues: [{ path: "nodes[0].id", code: "INVALID_NODE_ID" }],
		});
		expect(await h.plan()).toBeNull();
		expect(graph).toEqual(original);
		expect(await h.recorded()).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("private.source");
	});
	for (const patch of [
		{ id: "a2000000-0000-4000-8000-000000000003" },
		{ version: 9 },
		{ id: compilationPin.workflowDefinitionId.toUpperCase() },
	])
		test(`graph pin mismatch is recorded only under the canonical authored pin: ${JSON.stringify(patch)}`, async () => {
			const h = compilationHarness({ graph: { ...validGraph(), ...patch } });
			expect(
				await h.service.compileAndPersist(compilationRequest),
			).toMatchObject({
				outcome: "rejected",
				pin: compilationPin,
				issues: [{ code: "PIN_MISMATCH" }],
			});
			const rows = await h.recorded();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				organization_id: compilationPin.organizationId,
				workflow_definition_id: compilationPin.workflowDefinitionId,
				workflow_version: 2,
			});
			expect(await h.plan()).toBeNull();
		});
	test("rejection is successful only after record resolves", async () => {
		const h = compilationHarness({ graph: null });
		let release = () => {};
		let entered = () => {};
		const enteredRecord = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pendingRecord = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.state.beforeRecord = async () => {
			entered();
			await pendingRecord;
		};
		let finished = false;
		const result = h.service
			.compileAndPersist(compilationRequest)
			.then((value) => {
				finished = true;
				return value;
			});
		await enteredRecord;
		expect(finished).toBe(false);
		expect(await h.recorded()).toEqual([]);
		release();
		expect((await result).outcome).toBe("rejected");
		expect(await h.recorded()).toHaveLength(1);
	});
	test("rejected retries append actual rejection history", async () => {
		const h = compilationHarness({ graph: null });
		const first = await h.service.compileAndPersist(compilationRequest);
		const second = await h.service.compileAndPersist(compilationRequest);
		if (first.outcome !== "rejected" || second.outcome !== "rejected")
			throw new Error("Expected recorded rejections");
		expect(first.rejectionId).not.toBe(second.rejectionId);
		expect(await h.recorded()).toHaveLength(2);
		expect(await h.plan()).toBeNull();
	});
	test("legacy compiler diagnostic values and arbitrary key paths never escape", async () => {
		const marker = "PRIVATE_CREDENTIAL_SOURCE_SENTINEL";
		const graph = toolGraph(marker);
		graph.nodes.push({
			...graph.nodes[0],
			config: { tool: marker, [marker]: marker },
		});
		const h = compilationHarness({ graph });
		const result = await h.service.compileAndPersist(compilationRequest);
		expect(result.outcome).toBe("rejected");
		const stored = await h.recorded();
		expect(stored).toHaveLength(1);
		for (const value of [result, stored[0].issues])
			expect(JSON.stringify(value)).not.toContain(marker);
		if (result.outcome !== "rejected") throw new Error("Expected rejection");
		expect(
			result.issues.some(
				(issue) =>
					issue.code === "UNSAFE_CONFIG" && issue.path === "nodes[1].config",
			),
		).toBe(true);
		expect(stored[0].issues).toEqual(result.issues);
	});
	test("diagnostic volume is bounded before persistence", async () => {
		const graph = validGraph();
		graph.nodes = Array.from({ length: 130 }, () => ({
			...graph.nodes[0],
			id: "source-marker",
		}));
		const h = compilationHarness({ graph });
		const result = await h.service.compileAndPersist(compilationRequest);
		if (result.outcome !== "rejected") throw new Error("Expected rejection");
		expect(result.issues).toHaveLength(100);
		expect((await h.recorded())[0].issues).toHaveLength(100);
		expect(JSON.stringify(result)).not.toContain("source-marker");
	});
});
