import { expect, test } from "bun:test";
import { TASK_STATE_TRANSITIONS, type TaskStatus } from "@isolate/shared";
import {
	buildTransitionValuesSql,
	guardTransition,
	requireNonEmpty,
	requireNonNegativeInt,
	requirePositiveInt,
} from "./task-repository";

test("guardTransition accepts every declared transition when status matches", () => {
	for (const [from, targets] of Object.entries(TASK_STATE_TRANSITIONS)) {
		for (const to of targets) {
			const outcome = guardTransition(
				from as TaskStatus,
				from as TaskStatus,
				to,
			);
			expect(outcome.ok).toBe(true);
		}
	}
});

test("guardTransition rejects undeclared transitions with INVALID_TRANSITION", () => {
	// queued has no edge to completed or pull_request_created.
	expect(guardTransition("queued", "queued", "completed")).toEqual({
		ok: false,
		code: "INVALID_TRANSITION",
	});
	expect(guardTransition("queued", "queued", "pull_request_created")).toEqual({
		ok: false,
		code: "INVALID_TRANSITION",
	});
});

test("guardTransition rejects terminal states (no outgoing edges)", () => {
	for (const terminal of [
		"completed",
		"failed",
		"cancelled",
		"blocked",
	] as const) {
		expect(guardTransition(terminal, terminal, "executing")).toEqual({
			ok: false,
			code: "INVALID_TRANSITION",
		});
	}
});

test("guardTransition reports CONFLICT when current != expected", () => {
	// planning -> awaiting_approval is legal, but the row moved on already.
	expect(guardTransition("planning", "executing", "awaiting_approval")).toEqual(
		{
			ok: false,
			code: "CONFLICT",
		},
	);
});

test("buildTransitionValuesSql emits one (from,to) row per declared edge", () => {
	const fragment = buildTransitionValuesSql();
	const edgeCount = Object.values(TASK_STATE_TRANSITIONS).reduce(
		(sum, targets) => sum + targets.length,
		0,
	);
	// The SQL fragments pairs as ('a','b'), ('c','d') — count via "), (".
	expect(fragment.split("), (").length).toBe(edgeCount);
	expect(fragment).toContain("('queued','planning')");
	expect(fragment).not.toContain("('completed','queued')");
});

test("buildTransitionValuesSql rejects unknown status tokens", () => {
	expect(() =>
		buildTransitionValuesSql({ queued: ["definitely_not_a_status"] } as never),
	).toThrow(/target is not a known status/);
	expect(() => buildTransitionValuesSql({ not_a_status: [] } as never)).toThrow(
		/source is not a known status/,
	);
});

test("require* validators reject bad input", () => {
	expect(() => requireNonEmpty("", "x")).toThrow();
	expect(() => requireNonEmpty("   ", "x")).toThrow();
	expect(() => requirePositiveInt(0, "x")).toThrow();
	expect(() => requirePositiveInt(1.5, "x")).toThrow();
	expect(() => requirePositiveInt(1, "x")).not.toThrow();
	expect(() => requireNonNegativeInt(-1, "x")).toThrow();
	expect(() => requireNonNegativeInt(0, "x")).not.toThrow();
});
