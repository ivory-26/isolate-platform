import type {
	GitHubAccountType,
	GitHubInstallationStatus,
	GitHubRepositorySelection,
	OrganizationId,
	UserId,
} from "@isolate/shared";
import {
	GITHUB_ACCOUNT_TYPES,
	GITHUB_INSTALLATION_STATUSES,
	GITHUB_REPOSITORY_SELECTIONS,
} from "@isolate/shared";
import type { PgSql } from "../client";
import type { GitHubInstallationRow } from "../schema";
import { requireNonEmpty } from "./task-repository";

/**
 * Per-organization GitHub App installations (wave 23, migration 0016).
 *
 * One installation id may appear only once globally. An upsert by a different
 * organization returns `null` instead of moving the installation: a leaked id
 * can never reassign another tenant's App installation. Every read and write
 * carries `organization_id`.
 *
 * SECURITY: no App private key, JWT or installation token is stored here; the
 * row is tenant metadata only.
 */

export const MAX_INSTALLATION_ID_CHARS = 20;
export const MAX_ACCOUNT_LOGIN_CHARS = 100;
const INSTALLATION_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

export type UpsertGitHubInstallationInput = {
	readonly organizationId: OrganizationId;
	/** Numeric GitHub installation id; kept as a string (bigint-safe). */
	readonly installationId: string;
	readonly accountLogin: string;
	readonly accountType: GitHubAccountType;
	readonly repositorySelection: GitHubRepositorySelection;
	readonly status?: GitHubInstallationStatus;
	readonly createdBy?: UserId | null;
};

export type NormalizedGitHubInstallationInput = {
	organizationId: OrganizationId;
	installationId: string;
	accountLogin: string;
	accountType: GitHubAccountType;
	repositorySelection: GitHubRepositorySelection;
	status: GitHubInstallationStatus;
	createdBy: UserId | null;
};

export interface GitHubInstallationRepository {
	/**
	 * Creates or refreshes one installation. Returns `null` when the numeric
	 * installation id already belongs to a different organization.
	 */
	upsert(
		input: UpsertGitHubInstallationInput,
	): Promise<GitHubInstallationRow | null>;
	findByOrganization(
		organizationId: OrganizationId,
		installationId: string,
	): Promise<GitHubInstallationRow | null>;
	/** Newest active installation, or null. */
	findActiveByOrganization(
		organizationId: OrganizationId,
	): Promise<GitHubInstallationRow | null>;
	list(organizationId: OrganizationId): Promise<GitHubInstallationRow[]>;
	revoke(
		organizationId: OrganizationId,
		installationId: string,
	): Promise<GitHubInstallationRow | null>;
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

export function normalizeInstallationId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!INSTALLATION_ID_PATTERN.test(value) ||
		value.length > MAX_INSTALLATION_ID_CHARS
	) {
		throw new Error("installationId must be a positive numeric string");
	}
	return value;
}

export function normalizeGitHubInstallationInput(
	input: UpsertGitHubInstallationInput,
): NormalizedGitHubInstallationInput {
	requireNonEmpty(input.organizationId, "organizationId");
	const installationId = normalizeInstallationId(input.installationId);
	if (
		typeof input.accountLogin !== "string" ||
		input.accountLogin.trim().length === 0 ||
		input.accountLogin.trim().length > MAX_ACCOUNT_LOGIN_CHARS ||
		hasControlCharacters(input.accountLogin)
	) {
		throw new Error("accountLogin must be a bounded, control-free login");
	}
	if (!GITHUB_ACCOUNT_TYPES.includes(input.accountType)) {
		throw new Error("accountType must be User or Organization");
	}
	if (!GITHUB_REPOSITORY_SELECTIONS.includes(input.repositorySelection)) {
		throw new Error("repositorySelection must be all or selected");
	}
	const status = input.status ?? "active";
	if (!GITHUB_INSTALLATION_STATUSES.includes(status)) {
		throw new Error("status must be active, suspended or revoked");
	}
	const createdBy = input.createdBy ?? null;
	if (createdBy !== null) requireNonEmpty(createdBy, "createdBy");
	return {
		organizationId: input.organizationId,
		installationId,
		accountLogin: input.accountLogin.trim(),
		accountType: input.accountType,
		repositorySelection: input.repositorySelection,
		status,
		createdBy,
	};
}

const COLUMNS =
	"id, organization_id, installation_id, account_login, account_type, repository_selection, status, created_by, created_at, updated_at";

const STMT = {
	// A conflict on another tenant's installation id does not update and does
	// not return a row; the caller maps that to a tenant-safe refusal.
	upsert: `INSERT INTO github_installations (
		organization_id, installation_id, account_login, account_type,
		repository_selection, status, created_by
	) VALUES ($1, $2::bigint, $3, $4, $5, $6, $7)
	ON CONFLICT (installation_id) DO UPDATE SET
		account_login = EXCLUDED.account_login,
		account_type = EXCLUDED.account_type,
		repository_selection = EXCLUDED.repository_selection,
		status = EXCLUDED.status,
		updated_at = now()
	WHERE github_installations.organization_id = EXCLUDED.organization_id
	RETURNING ${COLUMNS}`,
	findByOrganization: `SELECT ${COLUMNS} FROM github_installations
		WHERE organization_id = $1 AND installation_id = $2::bigint`,
	findActive: `SELECT ${COLUMNS} FROM github_installations
		WHERE organization_id = $1 AND status = 'active'
		ORDER BY updated_at DESC, id DESC LIMIT 1`,
	list: `SELECT ${COLUMNS} FROM github_installations
		WHERE organization_id = $1
		ORDER BY created_at DESC, id DESC`,
	revoke: `UPDATE github_installations
		SET status = 'revoked', updated_at = now()
		WHERE organization_id = $1 AND installation_id = $2::bigint
		RETURNING ${COLUMNS}`,
} as const;

export function mapGitHubInstallationRow(
	row: Record<string, unknown>,
): GitHubInstallationRow {
	return {
		id: String(row.id),
		organization_id: row.organization_id as OrganizationId,
		installation_id: String(row.installation_id),
		account_login: String(row.account_login),
		account_type: row.account_type as GitHubAccountType,
		repository_selection: row.repository_selection as GitHubRepositorySelection,
		status: row.status as GitHubInstallationStatus,
		created_by:
			row.created_by === null || row.created_by === undefined
				? null
				: (String(row.created_by) as UserId),
		created_at: row.created_at as Date,
		updated_at: row.updated_at as Date,
	};
}

export class PostgresGitHubInstallationRepository
	implements GitHubInstallationRepository
{
	constructor(private readonly sql: PgSql) {}

	async upsert(
		input: UpsertGitHubInstallationInput,
	): Promise<GitHubInstallationRow | null> {
		const normalized = normalizeGitHubInstallationInput(input);
		const rows = (await this.sql.unsafe(STMT.upsert, [
			normalized.organizationId,
			normalized.installationId,
			normalized.accountLogin,
			normalized.accountType,
			normalized.repositorySelection,
			normalized.status,
			normalized.createdBy,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapGitHubInstallationRow(rows[0]);
	}

	async findByOrganization(
		organizationId: OrganizationId,
		installationId: string,
	): Promise<GitHubInstallationRow | null> {
		requireNonEmpty(organizationId, "organizationId");
		const id = normalizeInstallationId(installationId);
		const rows = (await this.sql.unsafe(STMT.findByOrganization, [
			organizationId,
			id,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapGitHubInstallationRow(rows[0]);
	}

	async findActiveByOrganization(
		organizationId: OrganizationId,
	): Promise<GitHubInstallationRow | null> {
		requireNonEmpty(organizationId, "organizationId");
		const rows = (await this.sql.unsafe(STMT.findActive, [
			organizationId,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapGitHubInstallationRow(rows[0]);
	}

	async list(organizationId: OrganizationId): Promise<GitHubInstallationRow[]> {
		requireNonEmpty(organizationId, "organizationId");
		const rows = (await this.sql.unsafe(STMT.list, [
			organizationId,
		])) as unknown as Record<string, unknown>[];
		return rows.map(mapGitHubInstallationRow);
	}

	async revoke(
		organizationId: OrganizationId,
		installationId: string,
	): Promise<GitHubInstallationRow | null> {
		requireNonEmpty(organizationId, "organizationId");
		const id = normalizeInstallationId(installationId);
		const rows = (await this.sql.unsafe(STMT.revoke, [
			organizationId,
			id,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapGitHubInstallationRow(rows[0]);
	}
}
