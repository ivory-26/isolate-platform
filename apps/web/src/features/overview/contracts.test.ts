import { describe, expect, test } from "bun:test";
import {
	ACTIVE_TASK_STATUSES,
	deriveOverviewMetrics,
	elapsedMsSince,
	eventTypeLabel,
	FAILURE_WINDOW_HOURS,
	isActiveTaskStatus,
	isTerminalTaskStatus,
	TERMINAL_TASK_STATUSES,
	windowStartIso,
} from "./contracts";

describe("overview metric derivation", () => {
	test("counts active work separately from the queue", () => {
		const metrics = deriveOverviewMetrics({
			statusCounts: {
				queued: 2,
				planning: 1,
				executing: 2,
				review_ready: 1,
				completed: 5,
				failed: 1,
			},
			pendingApprovals: 3,
			recentFailures: 1,
		});
		expect(metrics).toEqual({
			activeTasks: 4,
			queuedTasks: 2,
			pendingApprovals: 3,
			recentFailures: 1,
			failureWindowHours: FAILURE_WINDOW_HOURS,
		});
	});

	test("ignores unknown, negative and non-finite counts", () => {
		const metrics = deriveOverviewMetrics({
			statusCounts: {
				queued: -4,
				planning: Number.NaN,
				executing: 1.9,
				mystery: 10,
				failed: 100,
			},
			pendingApprovals: -1,
			recentFailures: Number.POSITIVE_INFINITY,
		});
		expect(metrics.activeTasks).toBe(1);
		expect(metrics.queuedTasks).toBe(0);
		expect(metrics.pendingApprovals).toBe(0);
		expect(metrics.recentFailures).toBe(0);
	});

	test("every active status is non-terminal and queued is not active", () => {
		for (const status of ACTIVE_TASK_STATUSES) {
			expect(isActiveTaskStatus(status)).toBe(true);
			expect(isTerminalTaskStatus(status)).toBe(false);
		}
		for (const status of TERMINAL_TASK_STATUSES) {
			expect(isTerminalTaskStatus(status)).toBe(true);
			expect(isActiveTaskStatus(status)).toBe(false);
		}
		expect(isActiveTaskStatus("queued")).toBe(false);
	});
});

describe("time windows and elapsed display", () => {
	test("windowStartIso subtracts the stated hours", () => {
		const now = new Date("2026-11-20T12:00:00.000Z");
		expect(windowStartIso(now, 24)).toBe("2026-11-19T12:00:00.000Z");
		expect(windowStartIso(now, 0)).toBe("2026-11-20T12:00:00.000Z");
		expect(windowStartIso(now, -5)).toBe("2026-11-20T12:00:00.000Z");
	});

	test("elapsedMsSince clamps to zero and tolerates invalid input", () => {
		const now = new Date("2026-11-20T12:00:00.000Z");
		expect(elapsedMsSince("2026-11-20T11:30:00.000Z", now)).toBe(1_800_000);
		expect(elapsedMsSince("2026-11-20T13:00:00.000Z", now)).toBe(0);
		expect(elapsedMsSince("not-a-date", now)).toBe(0);
		expect(elapsedMsSince(null, now)).toBe(0);
	});
});

describe("event labels", () => {
	test("known types use operator-facing labels", () => {
		expect(eventTypeLabel("approval.requested")).toBe("Approval requested");
		expect(eventTypeLabel("workflow.step_started")).toBe("Step started");
	});
	test("unknown and missing types never render a raw dot path alone", () => {
		expect(eventTypeLabel("custom.some_event")).toBe("Custom Some Event");
		expect(eventTypeLabel(null)).toBe("No events yet");
		expect(eventTypeLabel("")).toBe("No events yet");
	});
});
