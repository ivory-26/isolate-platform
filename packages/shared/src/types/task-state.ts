import { z } from "zod";

/**
 * Task lifecycle state machine (ARCHITECTURE.md §9).
 *
 * This is the single source of truth; the DB schema `CHECK` constraint and the
 * repository layer's transition guard must mirror it exactly.
 */
export const TASK_STATUSES = [
	"queued",
	"planning",
	"awaiting_approval",
	"executing",
	"validating",
	"repairing",
	"review_ready",
	"pull_request_created",
	"completed",
	"failed",
	"cancelled",
	"blocked",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = [
	"completed",
	"failed",
	"cancelled",
	"blocked",
];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return TASK_TERMINAL_STATUSES.includes(status);
}

/**
 * Allowed forward transitions. Every state not listed here (and `blocked`,
 * per architecture, a terminal stop state) is rejected with INVALID_TRANSITION.
 */
export const TASK_STATE_TRANSITIONS: Readonly<
	Record<TaskStatus, readonly TaskStatus[]>
> = {
	queued: ["planning", "failed", "cancelled", "blocked"],
	planning: [
		"awaiting_approval",
		"executing",
		"failed",
		"cancelled",
		"blocked",
	],
	awaiting_approval: ["executing", "failed", "cancelled", "blocked"],
	executing: ["validating", "failed", "cancelled", "blocked"],
	validating: ["repairing", "review_ready", "failed", "cancelled", "blocked"],
	// bounded repair budget is enforced separately with attempt counters
	repairing: ["validating", "failed", "cancelled", "blocked"],
	review_ready: [
		"pull_request_created",
		"completed",
		"failed",
		"cancelled",
		"blocked",
	],
	pull_request_created: ["completed", "failed", "cancelled", "blocked"],
	completed: [],
	failed: [],
	cancelled: [],
	blocked: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	return TASK_STATE_TRANSITIONS[from].includes(to);
}

export const taskStatusSchema = z.enum(TASK_STATUSES);
