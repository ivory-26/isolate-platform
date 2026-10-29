import type { OrganizationId, TaskId } from "./ids";

/**
 * One spend attribution row (wave 4, provider plane).
 *
 * Mirrors the existing `usage_records` table exactly — no migration. A model
 * call and a sandbox session both use this shape:
 * - model rows: provider `baseten`, model id, prompt/completion tokens, cost.
 * - sandbox rows: provider `modal`, `sandbox:<cpu>x<memMiB>`, null tokens, cost.
 *
 * `costUsd` is null when no trusted price configuration exists. Never guess,
 * never estimate silently, and never store a token count that was not reported
 * by the provider.
 */
export type UsageRecordInput = {
	organizationId: OrganizationId;
	taskId: TaskId | null;
	provider: string;
	modelId: string;
	promptTokens: number | null;
	completionTokens: number | null;
	costUsd: number | null;
};

/**
 * Trusted, server-only sink the worker writes spend through. Implemented by
 * `@isolate/db`'s `UsageRepository`; faked in tests. Failures propagate: the
 * caller decides whether a spend-accounting failure fails the task.
 */
export interface UsageSink {
	record(input: UsageRecordInput): Promise<void>;
}
