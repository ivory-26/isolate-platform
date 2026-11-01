import type {
	RunApproval,
	RunApprovalStatus,
	RunEventActor,
	RunJsonValue,
	RunsSummary,
	RunTaskIdentity,
} from "./contracts";
import { RUN_MAX_RETRY_DEPTH } from "./contracts";

/**
 * Pure presentation helpers for the Runs surfaces. They never touch SQL, the
 * router or React, so every rule (retry eligibility, effective approval
 * status, link safety, event labels) is unit tested directly.
 */

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
	"blocked",
]);

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
	"queued",
	"planning",
	"awaiting_approval",
	"executing",
	"validating",
	"repairing",
]);

const REVIEW_READY_STATUSES: ReadonlySet<string> = new Set([
	"review_ready",
	"pull_request_created",
	"completed",
]);

export function isTerminalStatus(status: string): boolean {
	return TERMINAL_STATUSES.has(status);
}

/** Counts grouped by task status into the four operational metrics. */
export function summarizeStatusCounts(
	counts: ReadonlyMap<string, number> | Record<string, number>,
): RunsSummary {
	const entries: Iterable<[string, number]> =
		counts instanceof Map ? counts.entries() : Object.entries(counts);
	let total = 0;
	let active = 0;
	let awaitingApproval = 0;
	let failed = 0;
	let reviewReady = 0;
	for (const [status, rawCount] of entries) {
		const count = Number.isFinite(rawCount)
			? Math.max(0, Math.trunc(rawCount))
			: 0;
		total += count;
		if (ACTIVE_STATUSES.has(status)) active += count;
		if (status === "awaiting_approval") awaitingApproval += count;
		if (status === "failed") failed += count;
		if (REVIEW_READY_STATUSES.has(status)) reviewReady += count;
	}
	return { total, active, awaitingApproval, failed, reviewReady };
}

/** Retry is offered only for a failed task that has depth left. */
export function canRetryTask(
	task: Pick<RunTaskIdentity, "status" | "retryDepth">,
) {
	return task.status === "failed" && task.retryDepth < RUN_MAX_RETRY_DEPTH;
}

/**
 * A row still marked `pending` past `expires_at` can no longer be decided; the
 * UI shows it as expired rather than offering a control that must fail.
 */
export function effectiveApprovalStatus(
	approval: Pick<RunApproval, "status" | "expiresAt">,
	now = Date.now(),
): RunApprovalStatus {
	if (approval.status !== "pending") return approval.status;
	const expiresAt = new Date(approval.expiresAt).getTime();
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return "expired";
	return "pending";
}

export function isDecidableApproval(
	approval: Pick<RunApproval, "status" | "expiresAt">,
	now = Date.now(),
): boolean {
	return effectiveApprovalStatus(approval, now) === "pending";
}

export const approvalActionPushBranch = "git.push_branch";
export const approvalActionCreatePullRequest = "github.create_pull_request";

/** Approve is only meaningful for actions with a server-side follow-up. */
export function isSupportedApprovalAction(action: string): boolean {
	return (
		action === approvalActionPushBranch ||
		action === approvalActionCreatePullRequest
	);
}

export function isHighImpactApproval(action: string): boolean {
	return isSupportedApprovalAction(action);
}

export function approvalActionLabel(action: string): string {
	if (action === approvalActionPushBranch) return "Push task branch";
	if (action === approvalActionCreatePullRequest) return "Open pull request";
	return action;
}

export function approveConsequence(action: string): string {
	if (action === approvalActionPushBranch) {
		return "Approving pushes this task branch to the connected repository, outside the sandbox. The exact payload hash is recorded in the audit trail.";
	}
	if (action === approvalActionCreatePullRequest) {
		return "Approving opens a pull request against the repository using the approved payload. The exact payload hash is recorded in the audit trail.";
	}
	return "This action has no server-side follow-up, so it cannot be approved from here. Rejecting fails the task.";
}

export function rejectConsequence(): string {
	return "Rejecting permanently refuses this approval, marks the task failed, and enqueues no follow-up work.";
}

/** Only https links are rendered as external actions. */
export function safeExternalUrl(
	value: string | null | undefined,
): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}

const EVENT_LABELS: Record<string, string> = {
	"task.enqueued": "Task queued",
	"task.claimed": "Worker claimed task",
	"task.retried": "Task retried",
	"workspace.cloned": "Workspace cloned",
	"agent.turn_started": "Agent turn started",
	"agent.turn_finished": "Agent turn finished",
	"tool.call": "Tool call",
	"tool.invoked": "Tool invoked",
	"approval.requested": "Approval requested",
	"approval.decided": "Approval decided",
	"validation.started": "Validation started",
	"validation.finished": "Validation finished",
	"acceptance.started": "Acceptance checks started",
	"acceptance.finished": "Acceptance checks finished",
	"artifact.created": "Artifact stored",
	"pr.created": "Pull request created",
	"workflow.step_started": "Workflow step started",
	"run.started": "Run started",
	"run.finished": "Run finished",
};

export function eventLabel(type: string): string {
	const known = EVENT_LABELS[type];
	if (known !== undefined) return known;
	const spaced = type.replaceAll("_", " ").replaceAll(".", " ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Stable React keys for append-only rows without a unique column projection.
 * The occurrence suffix keeps duplicate createdAt/type pairs distinct without
 * relying on the array index (which React discourages as a key).
 */
export function stableKeys<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
): string[] {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const base = keyOf(item);
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		return `${base}#${occurrence}`;
	});
}

export type EventTone = "neutral" | "brand" | "success" | "warning" | "danger";

export function eventTone(type: string): EventTone {
	if (type.startsWith("acceptance.")) return "brand";
	if (type === "pr.created") return "success";
	if (type === "approval.requested") return "warning";
	if (type === "approval.decided") return "success";
	if (type.startsWith("validation.")) return "warning";
	if (type.startsWith("agent.")) return "brand";
	if (type === "task.retried") return "warning";
	if (type === "artifact.created") return "success";
	return "neutral";
}

export const ACTOR_LABELS: Record<RunEventActor, string> = {
	user: "User",
	agent: "Agent",
	worker: "Worker",
	system: "System",
	policy: "Policy",
};

/** Keys worth surfacing in a compact timeline subtitle. */
const SUMMARY_KEYS = [
	"status",
	"stage",
	"step",
	"nodeId",
	"node",
	"turn",
	"attempt",
	"decision",
	"reason",
	"errorCode",
	"tool",
	"prNumber",
] as const;

export const EVENT_SUMMARY_MAX_LENGTH = 120;

function compactValue(value: RunJsonValue): string {
	if (value === null) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) return `[${value.length}]`;
	return "{…}";
}

/**
 * One line of bounded, key=value event metadata. Nested objects and arrays are
 * collapsed to a shape, never serialized wholesale.
 */
export function summarizeEventData(data: Record<string, RunJsonValue>): string {
	const parts: string[] = [];
	for (const key of SUMMARY_KEYS) {
		const value = data[key];
		if (value === undefined) continue;
		parts.push(`${key}=${compactValue(value)}`);
		if (parts.length >= 4) break;
	}
	const joined = parts.join(" · ");
	return joined.length > EVENT_SUMMARY_MAX_LENGTH
		? `${joined.slice(0, EVENT_SUMMARY_MAX_LENGTH - 1)}…`
		: joined;
}

/** UTC `HH:MM:SS.mmm` for the log viewer, independent of browser locale. */
export function formatLogTimestamp(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return "--:--:--.---";
	return parsed.toISOString().slice(11, 23);
}

export function formatBytes(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	const bytes = Math.max(0, Math.trunc(value));
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatTokens(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	return new Intl.NumberFormat("en-US").format(Math.trunc(value));
}

/** Exact decimal display for a `numeric(12,6)` cost string. */
export function formatCostUsd(value: string | null | undefined): string {
	if (value === null || value === undefined) return "—";
	const amount = Number(value);
	if (!Number.isFinite(amount)) return "—";
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: amount < 0.01 ? 4 : 2,
		maximumFractionDigits: amount < 0.01 ? 4 : 2,
	}).format(amount);
}

export function sumPromptTokens(
	usage: readonly { promptTokens: number | null }[],
): number {
	return usage.reduce((total, row) => total + (row.promptTokens ?? 0), 0);
}

export function sumCompletionTokens(
	usage: readonly { completionTokens: number | null }[],
): number {
	return usage.reduce((total, row) => total + (row.completionTokens ?? 0), 0);
}

/** Total cost as a decimal string; null when no row carried a price. */
export function sumCostUsd(
	usage: readonly { costUsd: string | null }[],
): string | null {
	let cents = 0;
	let priced = false;
	for (const row of usage) {
		if (row.costUsd === null) continue;
		const amount = Number(row.costUsd);
		if (!Number.isFinite(amount)) continue;
		cents += amount;
		priced = true;
	}
	return priced ? cents.toFixed(6) : null;
}
