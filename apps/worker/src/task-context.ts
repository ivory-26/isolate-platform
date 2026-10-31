import type { TaskContextRepository, TaskContextSourceRow } from "@isolate/db";
import type { TaskContext } from "@isolate/mastra";
import {
	MAX_INCIDENT_FINGERPRINT_CHARS,
	type OrganizationId,
	PlatformError,
	type TaskId,
} from "@isolate/shared";
import type { TaskExecutionDeps } from "./task-execution-handler";

/**
 * Database-backed `loadTaskContext`.
 *
 * One tenant-scoped read produces the whole task context. The repository
 * constrains both the task and its repository by organization id, and this
 * mapper re-checks that boundary before any prompt is built.
 *
 * Fails closed:
 * - missing/foreign task → NOT_FOUND (never a cross-tenant read);
 * - terminal task → NOT_FOUND (a redelivered job must not revive finished work);
 * - unsupported repository provider or malformed owner/name → VALIDATION_FAILED.
 */

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
	"blocked",
]);

/** GitHub `owner/name`; the full name becomes part of a public URL. */
const GITHUB_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_FULL_NAME_LENGTH = 200;

function safeFullName(value: string): string | null {
	if (value.length > MAX_FULL_NAME_LENGTH || !GITHUB_FULL_NAME.test(value)) {
		return null;
	}
	const [owner, name] = value.split("/");
	if (
		owner === undefined ||
		name === undefined ||
		owner === "." ||
		owner === ".." ||
		name === "." ||
		name === ".."
	) {
		return null;
	}
	return value;
}

export function toTaskContext(
	row: TaskContextSourceRow,
	expected: { organizationId: OrganizationId; taskId: TaskId },
): TaskContext {
	if (
		row.organizationId !== expected.organizationId ||
		row.taskId !== expected.taskId
	) {
		throw new PlatformError("NOT_FOUND", "task context not found");
	}
	if (TERMINAL_STATUSES.has(row.status)) {
		throw new PlatformError("NOT_FOUND", "task is not executable");
	}
	if (row.repositoryProvider !== "github") {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"unsupported repository provider",
		);
	}
	const fullName = safeFullName(row.repositoryFullName);
	if (fullName === null) {
		throw new PlatformError("VALIDATION_FAILED", "invalid repository name");
	}
	// Wave 9: the branch lock keys on a stable repository id. The column is
	// owned by the DB lane; until it is exposed the handler falls back to the
	// repository URL (identical for every job on one repository).
	const repositoryId = (row as { repositoryId?: unknown }).repositoryId;
	// Wave 13: the incident fingerprint selects whether bounded GitHub evidence
	// is fetched. Optional for older rows and fakes; bounded when present so a
	// malformed value can never become an unbounded prompt gate.
	const incidentFingerprint = (row as { incidentFingerprint?: unknown })
		.incidentFingerprint;
	return {
		taskId: row.taskId,
		organizationId: row.organizationId,
		goal: row.goal,
		repoUrl: `https://github.com/${fullName}.git`,
		baseBranch: row.repositoryDefaultBranch,
		isolatedBranch: row.branch,
		fileOwnership: [...row.fileOwnership],
		acceptanceCriteria: [...row.acceptanceCriteria],
		...(typeof repositoryId === "string" && repositoryId.length > 0
			? { repositoryId }
			: {}),
		...(typeof incidentFingerprint === "string" &&
		incidentFingerprint.trim().length > 0
			? {
					incidentFingerprint: incidentFingerprint
						.trim()
						.slice(0, MAX_INCIDENT_FINGERPRINT_CHARS),
				}
			: {}),
		limits: {
			max_agent_turns: row.budgetLimits.max_agent_turns,
			max_repair_attempts: row.budgetLimits.max_repair_attempts,
			max_duration_ms: row.budgetLimits.max_duration_ms,
		},
	};
}

export function createTaskContextLoader(
	repository: TaskContextRepository,
): TaskExecutionDeps["loadTaskContext"] {
	return async (input) => {
		const row = await repository.get(input);
		if (row === null) {
			throw new PlatformError("NOT_FOUND", "task context not found");
		}
		return toTaskContext(row, input);
	};
}
