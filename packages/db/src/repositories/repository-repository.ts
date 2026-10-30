import type { OrganizationId, RepositoryId } from "@isolate/shared";
import type { PgSql } from "../client";
import type { RepositoryRow } from "../schema";
import { requireNonEmpty } from "./task-repository";

/**
 * Organization-scoped repository onboarding (wave 7).
 *
 * A repository is identified inside one tenant by its provider full name
 * (`owner/repo`). `0005_execution_truth.sql` adds the unique index that makes
 * a second create a typed CONFLICT instead of a duplicate row. Every read and
 * write carries `organization_id`; a foreign repository is indistinguishable
 * from a missing one (`null`), so ids never leak across tenants.
 */

export type CreateRepositoryInput = {
	readonly organizationId: OrganizationId;
	readonly provider?: "github";
	readonly externalFullName: string;
	readonly defaultBranch: string;
};

export type CreateRepositoryFailCode = "CONFLICT";

export type CreateRepositoryResult =
	| { readonly ok: true; readonly repository: RepositoryRow }
	| { readonly ok: false; readonly code: CreateRepositoryFailCode };

export type SetValidationPolicyInput = {
	readonly organizationId: OrganizationId;
	readonly repositoryId: RepositoryId;
	/** The exact command an operator configured, or null to clear the gate. */
	readonly validationCommand: string | null;
	readonly validationTimeoutMs: number;
};

export interface RepositoryRepository {
	create(input: CreateRepositoryInput): Promise<CreateRepositoryResult>;
	get(input: {
		readonly organizationId: OrganizationId;
		readonly repositoryId: RepositoryId;
	}): Promise<RepositoryRow | null>;
	list(organizationId: OrganizationId): Promise<RepositoryRow[]>;
	/**
	 * Replaces the validation policy of one repository inside one tenant.
	 * Returns `null` for a foreign or absent repository id (indistinguishable
	 * by design), never another organization's row.
	 */
	setValidationPolicy(
		input: SetValidationPolicyInput,
	): Promise<RepositoryRow | null>;
}

/** Default validation timeout (5 minutes) mirrored by the 0006 column default. */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 300_000;
export const MIN_VALIDATION_TIMEOUT_MS = 1_000;
export const MAX_VALIDATION_TIMEOUT_MS = 900_000;
export const MAX_VALIDATION_COMMAND_LENGTH = 512;

/**
 * Shell characters that may never appear in a validation command. Validation
 * runs argv-only (no shell), so these characters have no legitimate meaning
 * here and are refused at the policy boundary; W8-VAL refuses the same set
 * again before execution.
 */
const VALIDATION_COMMAND_FORBIDDEN = /[;|&><$`]/;

/** ASCII control characters (newlines, NUL, DEL) are never part of a command. */
function hasControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Validates and normalizes a validation policy. Pure: shared by the Postgres
 * driver, the in-memory fake and the control-plane callers so bounds and
 * refusals cannot drift. An empty/whitespace command clears the policy (null).
 */
export function normalizeValidationPolicy(input: {
	validationCommand: string | null;
	validationTimeoutMs: number;
}): { validationCommand: string | null; validationTimeoutMs: number } {
	const { validationTimeoutMs } = input;
	if (
		!Number.isInteger(validationTimeoutMs) ||
		validationTimeoutMs < MIN_VALIDATION_TIMEOUT_MS ||
		validationTimeoutMs > MAX_VALIDATION_TIMEOUT_MS
	) {
		throw new Error(
			`validationTimeoutMs must be an integer between ${MIN_VALIDATION_TIMEOUT_MS} and ${MAX_VALIDATION_TIMEOUT_MS}`,
		);
	}
	if (input.validationCommand === null) {
		return { validationCommand: null, validationTimeoutMs };
	}
	if (typeof input.validationCommand !== "string") {
		throw new Error("validationCommand must be a string or null");
	}
	const command = input.validationCommand.trim();
	if (command.length === 0) {
		return { validationCommand: null, validationTimeoutMs };
	}
	if (command.length > MAX_VALIDATION_COMMAND_LENGTH) {
		throw new Error(
			`validationCommand must be at most ${MAX_VALIDATION_COMMAND_LENGTH} characters`,
		);
	}
	if (
		VALIDATION_COMMAND_FORBIDDEN.test(command) ||
		hasControlCharacter(command)
	) {
		throw new Error(
			"validationCommand must not contain shell metacharacters or control characters",
		);
	}
	return { validationCommand: command, validationTimeoutMs };
}

const REPOSITORY_COLUMNS =
	"id, organization_id, provider, external_full_name, default_branch, validation_command, validation_timeout_ms, created_at";

const STMT = {
	insert: `INSERT INTO repositories (
		organization_id, provider, external_full_name, default_branch
	) VALUES ($1, $2, $3, $4)
	ON CONFLICT (organization_id, external_full_name) DO NOTHING
	RETURNING ${REPOSITORY_COLUMNS}`,
	get: `SELECT ${REPOSITORY_COLUMNS} FROM repositories
		WHERE organization_id = $1 AND id = $2`,
	list: `SELECT ${REPOSITORY_COLUMNS} FROM repositories
		WHERE organization_id = $1
		ORDER BY external_full_name ASC, id ASC`,
	setValidationPolicy: `UPDATE repositories
		SET validation_command = $3, validation_timeout_ms = $4
		WHERE organization_id = $1 AND id = $2
		RETURNING ${REPOSITORY_COLUMNS}`,
} as const;

/**
 * Validates and normalizes a create input. The full name is stored verbatim
 * (GitHub lowercases at the API, but the platform never rewrites authored
 * identifiers); only shape and bounds are checked here.
 */
export function validateCreateRepositoryInput(input: CreateRepositoryInput): {
	organizationId: OrganizationId;
	provider: "github";
	externalFullName: string;
	defaultBranch: string;
} {
	requireNonEmpty(input.organizationId, "organizationId");
	requireNonEmpty(input.externalFullName, "externalFullName");
	requireNonEmpty(input.defaultBranch, "defaultBranch");
	const provider = input.provider ?? "github";
	if (provider !== "github") {
		throw new Error("provider must be 'github'");
	}
	if (input.externalFullName.length > 200) {
		throw new Error("externalFullName must be at most 200 characters");
	}
	const parts = input.externalFullName.split("/");
	if (
		parts.length !== 2 ||
		parts[0].length === 0 ||
		parts[1].length === 0 ||
		/\s/.test(input.externalFullName)
	) {
		throw new Error("externalFullName must be 'owner/repo' without whitespace");
	}
	if (input.defaultBranch.length > 255) {
		throw new Error("defaultBranch must be at most 255 characters");
	}
	return {
		organizationId: input.organizationId,
		provider,
		externalFullName: input.externalFullName,
		defaultBranch: input.defaultBranch,
	};
}

export class PostgresRepositoryRepository implements RepositoryRepository {
	constructor(private readonly sql: PgSql) {}

	async create(input: CreateRepositoryInput): Promise<CreateRepositoryResult> {
		const validated = validateCreateRepositoryInput(input);
		const rows = (await this.sql.unsafe(STMT.insert, [
			validated.organizationId,
			validated.provider,
			validated.externalFullName,
			validated.defaultBranch,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			// ON CONFLICT DO NOTHING fired: the full name is already onboarded
			// for this organization, regardless of default branch/provider.
			return { ok: false, code: "CONFLICT" };
		}
		return { ok: true, repository: mapRepositoryRow(rows[0]) };
	}

	async get(input: {
		organizationId: OrganizationId;
		repositoryId: RepositoryId;
	}): Promise<RepositoryRow | null> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.repositoryId, "repositoryId");
		const rows = (await this.sql.unsafe(STMT.get, [
			input.organizationId,
			input.repositoryId,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapRepositoryRow(rows[0]);
	}

	async list(organizationId: OrganizationId): Promise<RepositoryRow[]> {
		requireNonEmpty(organizationId, "organizationId");
		const rows = (await this.sql.unsafe(STMT.list, [
			organizationId,
		])) as unknown as Record<string, unknown>[];
		return rows.map(mapRepositoryRow);
	}

	async setValidationPolicy(
		input: SetValidationPolicyInput,
	): Promise<RepositoryRow | null> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.repositoryId, "repositoryId");
		const policy = normalizeValidationPolicy(input);
		const rows = (await this.sql.unsafe(STMT.setValidationPolicy, [
			input.organizationId,
			input.repositoryId,
			policy.validationCommand,
			policy.validationTimeoutMs,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapRepositoryRow(rows[0]);
	}
}

export function mapRepositoryRow(row: Record<string, unknown>): RepositoryRow {
	return {
		id: row.id as RepositoryRow["id"],
		organization_id: row.organization_id as RepositoryRow["organization_id"],
		provider: row.provider as RepositoryRow["provider"],
		external_full_name: row.external_full_name as string,
		default_branch: row.default_branch as string,
		validation_command: row.validation_command as string | null,
		validation_timeout_ms: Number(
			row.validation_timeout_ms ?? DEFAULT_VALIDATION_TIMEOUT_MS,
		),
		created_at: row.created_at as Date,
	};
}
