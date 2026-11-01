import type {
	WorkflowRejectionSummary,
	WorkflowSummary,
	WorkflowValidationState,
} from "./contracts";

/**
 * Pure workflow-library projection. Rows come from the tenant-scoped SQL in
 * `catalog-read.server.ts`; these helpers add no I/O so the validation state
 * can be tested with literal rows.
 */
export type WorkflowReadRow = {
	id: unknown;
	name: unknown;
	created_at: unknown;
	created_by_name: unknown;
	version_count: unknown;
	latest_version: unknown;
	latest_version_at: unknown;
	compiled_plan_count: unknown;
	latest_plan_version: unknown;
	latest_rejection_issue_count: unknown;
	latest_rejection_version: unknown;
	latest_rejection_at: unknown;
};

function count(value: unknown): number {
	if (value === null || value === undefined) return 0;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error("workflow read returned an invalid count");
	}
	return Math.floor(parsed);
}

function optionalCount(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	return count(value);
}

function timestamp(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	throw new Error("workflow read returned an invalid timestamp");
}

function optionalTimestamp(value: unknown): string | null {
	return value === null || value === undefined ? null : timestamp(value);
}

function optionalText(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

export function workflowValidationState(input: {
	latestVersion: number | null;
	latestPlanVersion: number | null;
	latestRejectionVersion: number | null;
}): WorkflowValidationState {
	const { latestVersion, latestPlanVersion, latestRejectionVersion } = input;
	if (latestVersion === null) return "draft";
	if (latestPlanVersion !== null && latestPlanVersion >= latestVersion) {
		return "validated";
	}
	if (latestRejectionVersion === latestVersion) return "rejected";
	return "not_compiled";
}

export function summarizeWorkflowRow(row: WorkflowReadRow): WorkflowSummary {
	const latestVersion = optionalCount(row.latest_version);
	const latestPlanVersion = optionalCount(row.latest_plan_version);
	const rejectionVersion = optionalCount(row.latest_rejection_version);
	const rejectionCreatedAt = optionalTimestamp(row.latest_rejection_at);
	const latestRejection: WorkflowRejectionSummary | null =
		rejectionVersion === null || rejectionCreatedAt === null
			? null
			: {
					version: rejectionVersion,
					issueCount: count(row.latest_rejection_issue_count),
					createdAt: rejectionCreatedAt,
				};
	return {
		id: String(row.id),
		name: String(row.name),
		createdBy: optionalText(row.created_by_name),
		createdAt: timestamp(row.created_at),
		latestVersion,
		latestVersionAt: optionalTimestamp(row.latest_version_at),
		versionCount: count(row.version_count),
		compiledPlanCount: count(row.compiled_plan_count),
		latestRejection,
		validationState: workflowValidationState({
			latestVersion,
			latestPlanVersion,
			latestRejectionVersion: rejectionVersion,
		}),
	};
}
