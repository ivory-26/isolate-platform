import type { OrganizationId, TaskId } from "@isolate/shared";
import type { PgSql } from "../client";
import type { ArtifactKind, ArtifactRow } from "../schema";
import { requireNonEmpty } from "./task-repository";

/**
 * Bounded inline artifacts (wave 7).
 *
 * `0005_execution_truth.sql` adds `artifacts.content text` with a 256 KiB
 * BYTE cap. Wave 7 stores the diff inline and keeps `storage_ref` as
 * `inline:<sha256>`; the caller supplies the digest of the exact stored bytes
 * and it is persisted verbatim (never recomputed here). Oversize content is
 * rejected before the INSERT, so the database CHECK is a backstop, not the
 * primary gate.
 *
 * The insert selects from `tasks` under the same organization, so a foreign or
 * missing task is NOT_FOUND and can never receive an artifact.
 */

export const MAX_INLINE_ARTIFACT_BYTES = 262144;

export type CreateArtifactInput = {
	readonly organizationId: OrganizationId;
	readonly taskId: TaskId;
	readonly kind: ArtifactKind;
	readonly contentType: string;
	readonly content: string;
	readonly sha256: string;
};

export type CreateArtifactFailCode = "NOT_FOUND" | "CONTENT_TOO_LARGE";

export type CreateArtifactResult =
	| { readonly ok: true; readonly artifact: ArtifactRow }
	| { readonly ok: false; readonly code: CreateArtifactFailCode };

export interface ArtifactRepository {
	create(input: CreateArtifactInput): Promise<CreateArtifactResult>;
	listByTask(input: {
		readonly organizationId: OrganizationId;
		readonly taskId: TaskId;
	}): Promise<ArtifactRow[]>;
}

const ARTIFACT_COLUMNS =
	"id, task_id, organization_id, kind, storage_ref, content_type, byte_size, sha256, content, created_at";

const STMT = {
	insert: `INSERT INTO artifacts (
		task_id, organization_id, kind, storage_ref, content_type, byte_size,
		sha256, content
	)
	SELECT t.id, t.organization_id, $3, $4, $5, $6, $7, $8
	FROM tasks t
	WHERE t.id = $2 AND t.organization_id = $1
	RETURNING ${ARTIFACT_COLUMNS}`,
	listByTask: `SELECT ${ARTIFACT_COLUMNS} FROM artifacts
		WHERE organization_id = $1 AND task_id = $2
		ORDER BY created_at DESC, id DESC`,
} as const;

/**
 * Pure byte-cap gate shared by the Postgres driver and the in-memory fake.
 * `Buffer.byteLength` measures UTF-8 exactly like Postgres `octet_length`.
 */
export function evaluateArtifactContent(content: string):
	| {
			readonly ok: true;
			readonly byteSize: number;
	  }
	| {
			readonly ok: false;
			readonly code: "CONTENT_TOO_LARGE";
	  } {
	if (typeof content !== "string") {
		throw new Error("content must be a string");
	}
	const byteSize = Buffer.byteLength(content, "utf8");
	if (byteSize > MAX_INLINE_ARTIFACT_BYTES) {
		return { ok: false, code: "CONTENT_TOO_LARGE" };
	}
	return { ok: true, byteSize };
}

export function isSha256Hex(value: string): boolean {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Structural validation only. The byte cap is a typed outcome
 * (`CONTENT_TOO_LARGE`) evaluated by `create`, so callers can map it without
 * parsing a message.
 */
export function validateCreateArtifactInput(input: CreateArtifactInput): {
	organizationId: OrganizationId;
	taskId: TaskId;
	kind: ArtifactKind;
	contentType: string;
	content: string;
	sha256: string;
} {
	requireNonEmpty(input.organizationId, "organizationId");
	requireNonEmpty(input.taskId, "taskId");
	requireNonEmpty(input.contentType, "contentType");
	if (input.contentType.length > 255) {
		throw new Error("contentType must be at most 255 characters");
	}
	if (!isSha256Hex(input.sha256)) {
		throw new Error("sha256 must be a 64-char lowercase hex digest");
	}
	if (typeof input.content !== "string") {
		throw new Error("content must be a string");
	}
	return {
		organizationId: input.organizationId,
		taskId: input.taskId,
		kind: input.kind,
		contentType: input.contentType,
		content: input.content,
		sha256: input.sha256,
	};
}

export class PostgresArtifactRepository implements ArtifactRepository {
	constructor(private readonly sql: PgSql) {}

	async create(input: CreateArtifactInput): Promise<CreateArtifactResult> {
		// The cap gate must run BEFORE the insert; oversize content never reaches
		// SQL. Structural problems (bad digest/type/kind) are caller bugs and throw.
		const validated = validateCreateArtifactInput(input);
		const content = evaluateArtifactContent(validated.content);
		if (!content.ok) {
			return content;
		}
		const rows = (await this.sql.unsafe(STMT.insert, [
			validated.organizationId,
			validated.taskId,
			validated.kind,
			`inline:${validated.sha256}`,
			validated.contentType,
			content.byteSize,
			validated.sha256,
			validated.content,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			// The tenant-scoped SELECT found no task row.
			return { ok: false, code: "NOT_FOUND" };
		}
		return { ok: true, artifact: mapArtifactRow(rows[0]) };
	}

	async listByTask(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
	}): Promise<ArtifactRow[]> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		const rows = (await this.sql.unsafe(STMT.listByTask, [
			input.organizationId,
			input.taskId,
		])) as unknown as Record<string, unknown>[];
		return rows.map(mapArtifactRow);
	}
}

export function mapArtifactRow(row: Record<string, unknown>): ArtifactRow {
	return {
		id: row.id as string,
		task_id: row.task_id as ArtifactRow["task_id"],
		organization_id: row.organization_id as ArtifactRow["organization_id"],
		kind: row.kind as ArtifactKind,
		storage_ref: row.storage_ref as string,
		content_type: row.content_type as string,
		// bigint columns arrive as strings from postgres.js (int8 parser); the
		// inline cap makes the value safe to narrow here.
		byte_size: toByteSize(row.byte_size),
		sha256: row.sha256 as string,
		content: row.content as string | null,
		created_at: row.created_at as Date,
	};
}

function toByteSize(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error("artifact byte_size is not a non-negative integer");
	}
	return parsed;
}
