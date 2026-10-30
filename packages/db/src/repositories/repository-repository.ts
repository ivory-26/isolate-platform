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

export interface RepositoryRepository {
	create(input: CreateRepositoryInput): Promise<CreateRepositoryResult>;
	get(input: {
		readonly organizationId: OrganizationId;
		readonly repositoryId: RepositoryId;
	}): Promise<RepositoryRow | null>;
	list(organizationId: OrganizationId): Promise<RepositoryRow[]>;
}

const REPOSITORY_COLUMNS =
	"id, organization_id, provider, external_full_name, default_branch, created_at";

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
}

export function mapRepositoryRow(row: Record<string, unknown>): RepositoryRow {
	return {
		id: row.id as RepositoryRow["id"],
		organization_id: row.organization_id as RepositoryRow["organization_id"],
		provider: row.provider as RepositoryRow["provider"],
		external_full_name: row.external_full_name as string,
		default_branch: row.default_branch as string,
		created_at: row.created_at as Date,
	};
}
