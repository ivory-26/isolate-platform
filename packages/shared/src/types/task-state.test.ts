import { describe, expect, test } from "bun:test";
import {
	canTransition,
	isTerminalTaskStatus,
	TASK_STATE_TRANSITIONS,
	TASK_STATUSES,
	TASK_TERMINAL_STATUSES,
	type TaskStatus,
	taskStatusSchema,
} from "./task-state";

describe("task state machine", () => {
	test("every declared transition is legal", () => {
		for (const [from, targets] of Object.entries(TASK_STATE_TRANSITIONS)) {
			for (const to of targets) {
				expect(canTransition(from as TaskStatus, to as TaskStatus)).toBe(true);
			}
		}
	});

	test("no state transitions to itself", () => {
		for (const from of TASK_STATUSES) {
			expect(canTransition(from, from)).toBe(false);
		}
	});

	test("terminal states reject every outgoing transition", () => {
		for (const terminal of TASK_TERMINAL_STATUSES) {
			for (const to of TASK_STATUSES) {
				expect(canTransition(terminal, to)).toBe(false);
			}
		}
	});

	test("every state has at least one declared rejection", () => {
		for (const from of TASK_STATUSES) {
			const declared = new Set<string>(TASK_STATE_TRANSITIONS[from]);
			const rejections = TASK_STATUSES.filter((to) => !declared.has(to));
			expect(rejections.length).toBeGreaterThan(0);
			// at least one concrete rejection per state (e.g. self or a wrong hop):
			expect(canTransition(from, rejections[0])).toBe(false);
		}
	});

	test("every non-terminal state has at least one forward path", () => {
		for (const from of TASK_STATUSES) {
			if (!isTerminalTaskStatus(from)) {
				expect(TASK_STATE_TRANSITIONS[from].length).toBeGreaterThan(0);
			}
		}
	});

	test("isTerminalTaskStatus matches the terminal list exactly", () => {
		for (const status of TASK_STATUSES) {
			expect(isTerminalTaskStatus(status)).toBe(
				TASK_TERMINAL_STATUSES.includes(status),
			);
		}
	});

	test("taskStatusSchema accepts declared statuses and rejects unknown ones", () => {
		for (const status of TASK_STATUSES) {
			expect(taskStatusSchema.safeParse(status).success).toBe(true);
		}
		expect(taskStatusSchema.safeParse("dreaming").success).toBe(false);
		expect(taskStatusSchema.safeParse(7).success).toBe(false);
	});
});
