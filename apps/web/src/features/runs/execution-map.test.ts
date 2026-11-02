import { describe, expect, test } from "bun:test";
import type { RunAttempt, RunEventView, RunToolInvocation } from "./contracts";
import {
	buildExecutionMap,
	type ExecutionMapSource,
	type ExecutionNode,
} from "./execution-map";

const TASK_ID = "33333333-3333-4333-8333-333333333333";
const REPO_ID = "11111111-1111-4111-8111-111111111111";

function attempt(overrides: Partial<RunAttempt> = {}): RunAttempt {
	return {
		attemptIndex: 1,
		status: "review_ready",
		startedAt: "2026-11-20T10:00:00.000Z",
		finishedAt: "2026-11-20T10:02:00.000Z",
		errorCode: null,
		...overrides,
	};
}

function event(overrides: Partial<RunEventView> = {}): RunEventView {
	return {
		type: "agent.turn_started",
		actor: "worker",
		data: {},
		createdAt: "2026-11-20T10:00:00.000Z",
		...overrides,
	};
}

function tool(overrides: Partial<RunToolInvocation> = {}): RunToolInvocation {
	return {
		toolName: "repo.read_file",
		decision: "allowed",
		denialReason: null,
		argumentsHash: "a".repeat(64),
		durationMs: 12,
		createdAt: "2026-11-20T10:00:30.000Z",
		...overrides,
	};
}

function source(
	overrides: Partial<ExecutionMapSource> = {},
): ExecutionMapSource {
	return {
		task: {
			id: TASK_ID,
			branch: "task/execution-map",
			status: "failed",
			repository: {
				id: REPO_ID,
				fullName: "acme/app",
				defaultBranch: "main",
			},
		},
		attempts: [],
		events: [],
		toolInvocations: [],
		connectorCalls: [],
		approvals: [],
		artifacts: [],
		...overrides,
	};
}

function labels(nodes: readonly ExecutionNode[]): string[] {
	return nodes.map((node) => node.label);
}

describe("buildExecutionMap attempts", () => {
	test("orders attempts by attemptIndex regardless of input order", () => {
		const map = buildExecutionMap(
			source({
				attempts: [
					attempt({
						attemptIndex: 2,
						startedAt: "2026-11-20T10:04:00.000Z",
					}),
					attempt({ attemptIndex: 1 }),
				],
			}),
		);
		expect(labels(map.root.children)).toEqual(["Attempt 1", "Attempt 2"]);
		expect(map.attemptCount).toBe(2);
		expect(map.hasAttempts).toBe(true);
	});

	test("attaches a step to the attempt whose window contains it", () => {
		const map = buildExecutionMap(
			source({
				attempts: [
					attempt({ attemptIndex: 1 }),
					attempt({
						attemptIndex: 2,
						startedAt: "2026-11-20T10:04:00.000Z",
						finishedAt: "2026-11-20T10:06:00.000Z",
					}),
				],
				toolInvocations: [
					tool({ createdAt: "2026-11-20T10:01:00.000Z" }),
					tool({
						toolName: "repo.search",
						createdAt: "2026-11-20T10:05:00.000Z",
					}),
				],
			}),
		);
		const first = map.root.children[0];
		const second = map.root.children[1];
		expect(first?.children.map((node) => node.kind)).toEqual(["tool"]);
		expect(second?.children.map((node) => node.kind)).toEqual(["tool"]);
		expect(second?.children[0]?.label).toBe("repo.search");
	});
});

describe("buildExecutionMap agent turns", () => {
	test("groups turns by data.agentId when delegation was recorded", () => {
		const map = buildExecutionMap(
			source({
				attempts: [attempt()],
				events: [
					event({
						data: { turn: 1, agentId: "agent-a" },
						createdAt: "2026-11-20T10:00:10.000Z",
					}),
					event({
						type: "agent.turn_finished",
						data: { turn: 1, agentId: "agent-a" },
						createdAt: "2026-11-20T10:00:20.000Z",
					}),
					event({
						data: { turn: 1, agentId: "agent-b" },
						createdAt: "2026-11-20T10:00:30.000Z",
					}),
					event({
						type: "agent.turn_finished",
						data: { turn: 1, agentId: "agent-b" },
						createdAt: "2026-11-20T10:00:40.000Z",
					}),
				],
			}),
		);
		const agents = map.root.children[0]?.children ?? [];
		expect(labels(agents)).toEqual(["agent-a", "agent-b"]);
		expect(map.hasAgentId).toBe(true);
		expect(map.turnCount).toBe(2);
		expect(agents[0]?.children[0]?.label).toBe("Turn 1");
	});

	test("falls back to one Primary agent when no agentId is recorded", () => {
		const map = buildExecutionMap(
			source({
				attempts: [attempt()],
				events: [
					event({
						data: { turn: 1 },
						createdAt: "2026-11-20T10:00:10.000Z",
					}),
					event({
						type: "agent.turn_finished",
						data: { turn: 1 },
						createdAt: "2026-11-20T10:00:20.000Z",
					}),
				],
			}),
		);
		const agents = map.root.children[0]?.children ?? [];
		expect(labels(agents)).toEqual(["Primary agent"]);
		expect(map.hasAgentId).toBe(false);
	});

	test("ignores a non-string agentId rather than inventing a subagent", () => {
		const map = buildExecutionMap(
			source({
				attempts: [attempt()],
				events: [
					event({
						data: { turn: 1, agentId: 42 },
						createdAt: "2026-11-20T10:00:10.000Z",
					}),
				],
			}),
		);
		expect(map.hasAgentId).toBe(false);
		expect(map.root.children[0]?.children[0]?.label).toBe("Primary agent");
	});
});

describe("buildExecutionMap child attachment", () => {
	test("attaches steps to the running turn and leaves later steps on the attempt", () => {
		const map = buildExecutionMap(
			source({
				attempts: [attempt()],
				events: [
					event({
						data: { turn: 1 },
						createdAt: "2026-11-20T10:00:00.000Z",
					}),
					event({
						type: "agent.turn_finished",
						data: { turn: 1 },
						createdAt: "2026-11-20T10:01:00.000Z",
					}),
					event({
						type: "validation.finished",
						data: { stage: "command", status: "passed" },
						createdAt: "2026-11-20T10:01:30.000Z",
					}),
				],
				toolInvocations: [
					tool({ createdAt: "2026-11-20T10:00:30.000Z" }),
					tool({
						toolName: "repo.search",
						createdAt: "2026-11-20T10:01:45.000Z",
					}),
				],
			}),
		);
		const attemptNode = map.root.children[0];
		expect(attemptNode?.children.map((node) => node.kind)).toEqual([
			"agent",
			"validation",
			"tool",
		]);
		const turnNode = attemptNode?.children[0]?.children[0];
		expect(turnNode?.kind).toBe("turn");
		expect(turnNode?.children.map((node) => node.kind)).toEqual(["tool"]);
		expect(turnNode?.children[0]?.label).toBe("repo.read_file");
	});

	test("sorts direct steps chronologically even when rows arrive out of order", () => {
		const map = buildExecutionMap(
			source({
				attempts: [attempt()],
				toolInvocations: [
					tool({ toolName: "late", createdAt: "2026-11-20T10:01:30.000Z" }),
					tool({ toolName: "early", createdAt: "2026-11-20T10:00:30.000Z" }),
				],
			}),
		);
		expect(labels(map.root.children[0]?.children ?? [])).toEqual([
			"early",
			"late",
		]);
	});
});

describe("buildExecutionMap empty states", () => {
	test("an attempt with no steps has no children for the component to explain", () => {
		const map = buildExecutionMap(source({ attempts: [attempt()] }));
		expect(map.root.children[0]?.children).toEqual([]);
		expect(map.turnCount).toBe(0);
		expect(map.stepCount).toBe(0);
	});

	test("without attempt rows the recorded steps hang off the task", () => {
		const map = buildExecutionMap(
			source({
				toolInvocations: [tool()],
				events: [
					event({
						data: { turn: 1 },
						createdAt: "2026-11-20T10:00:00.000Z",
					}),
				],
			}),
		);
		expect(map.hasAttempts).toBe(false);
		expect(map.root.children.map((node) => node.kind)).toEqual(["agent"]);
		expect(
			map.root.children[0]?.children[0]?.children.map((node) => node.kind),
		).toEqual(["tool"]);
	});

	test("a task with nothing recorded has an empty root", () => {
		const map = buildExecutionMap(source());
		expect(map.root.children).toEqual([]);
		expect(map.hasAttempts).toBe(false);
		expect(map.hasAgentId).toBe(false);
	});
});
