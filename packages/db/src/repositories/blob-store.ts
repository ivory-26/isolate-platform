import type {
	BlobKind,
	BlobRef,
	BlobStore,
	BlobStoreGetInput,
	BlobStorePutInput,
	BlobStoreValue,
} from "@isolate/shared";
import type { PgSql } from "../client";
import { isSha256Hex } from "./artifact-repository";

/**
 * Tenant-scoped blob storage for large artifacts (wave 11).
 *
 * The inline `artifacts.content` column is capped at 256 KiB; diffs and log
 * bundles that outgrow it live here and `artifacts.storage_ref` points at the
 * bytes as `blob:<sha256>`. The 2 MiB cap is enforced before any write, so the
 * database CHECK (and the `integer byte_size` column) never sees oversize
 * input.
 *
 * Dedupe is per organization: `(organization_id, sha256)` is unique and `put`
 * inserts with `ON CONFLICT DO NOTHING` followed by a tenant-scoped SELECT.
 * `get` filters on `organization_id` first, so another tenant's digest returns
 * `null` exactly like a missing row (foreign and absent are indistinguishable).
 *
 * The `BlobStore` interface is the seam for an object-storage backend (S3/R2):
 * an implementation only has to keep `blob:<sha256>` resolvable and preserve
 * the tenant scoping contract. This lane adds no cloud credentials.
 */

export const MAX_BLOB_BYTES = 2 * 1024 * 1024;
export const MAX_BLOB_CONTENT_TYPE_LENGTH = 128;
export const BLOB_STORAGE_REF_PREFIX = "blob:";

export const BLOB_KINDS: readonly BlobKind[] = [
	"diff",
	"log_bundle",
	"report",
	"screenshot",
];

export type BlobStoreErrorCode =
	| "INVALID_INPUT"
	| "BYTES_TOO_LARGE"
	| "TASK_NOT_FOUND";

/** Typed rejection so callers never parse error messages. */
export class BlobStoreError extends Error {
	constructor(
		readonly code: BlobStoreErrorCode,
		message: string,
	) {
		super(message);
		this.name = "BlobStoreError";
	}
}

/** `blob:<sha256>` — the stable reference persisted on the artifact row. */
export function formatBlobStorageRef(sha256: string): string {
	if (!isSha256Hex(sha256)) {
		throw new BlobStoreError(
			"INVALID_INPUT",
			"sha256 must be a 64-char lowercase hex digest",
		);
	}
	return `${BLOB_STORAGE_REF_PREFIX}${sha256}`;
}

/**
 * Extracts the digest from a storage ref. Returns `null` for anything that is
 * not exactly `blob:<64 lowercase hex>`; `get` then answers `null` as well.
 */
export function parseBlobStorageRef(storageRef: string): string | null {
	if (typeof storageRef !== "string") return null;
	if (!storageRef.startsWith(BLOB_STORAGE_REF_PREFIX)) return null;
	const sha256 = storageRef.slice(BLOB_STORAGE_REF_PREFIX.length);
	return isSha256Hex(sha256) ? sha256 : null;
}

export type ValidatedBlobPutInput = {
	readonly organizationId: string;
	readonly taskId: string | null;
	readonly kind: BlobKind;
	readonly contentType: string;
	readonly bytes: Uint8Array;
	readonly sha256: string;
	readonly byteSize: number;
};

function requireText(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new BlobStoreError(
			"INVALID_INPUT",
			`${field} must be a non-empty string`,
		);
	}
	return value;
}

/**
 * Structural validation plus the 2 MiB cap. The size gate runs before any SQL,
 * so oversize bytes are never bound to a statement.
 */
export function validateBlobPutInput(
	input: BlobStorePutInput,
): ValidatedBlobPutInput {
	const organizationId = requireText(input.organizationId, "organizationId");
	const taskId =
		input.taskId === null ? null : requireText(input.taskId, "taskId");
	if (!BLOB_KINDS.includes(input.kind)) {
		throw new BlobStoreError(
			"INVALID_INPUT",
			`kind must be one of: ${BLOB_KINDS.join(", ")}`,
		);
	}
	if (
		typeof input.contentType !== "string" ||
		input.contentType.length < 1 ||
		input.contentType.length > MAX_BLOB_CONTENT_TYPE_LENGTH
	) {
		throw new BlobStoreError(
			"INVALID_INPUT",
			`contentType must be 1-${MAX_BLOB_CONTENT_TYPE_LENGTH} characters`,
		);
	}
	if (!(input.bytes instanceof Uint8Array)) {
		throw new BlobStoreError("INVALID_INPUT", "bytes must be a Uint8Array");
	}
	if (!isSha256Hex(input.sha256)) {
		throw new BlobStoreError(
			"INVALID_INPUT",
			"sha256 must be a 64-char lowercase hex digest",
		);
	}
	const byteSize = input.bytes.byteLength;
	if (byteSize > MAX_BLOB_BYTES) {
		throw new BlobStoreError(
			"BYTES_TOO_LARGE",
			`bytes must be at most ${MAX_BLOB_BYTES} bytes`,
		);
	}
	return {
		organizationId,
		taskId,
		kind: input.kind,
		contentType: input.contentType,
		bytes: input.bytes,
		sha256: input.sha256,
		byteSize,
	};
}

const BLOB_COLUMNS =
	"organization_id, task_id, kind, content_type, byte_size, sha256";

const STMT = {
	// The tenant-scoped EXISTS guard rejects a task that is missing or owned by
	// another organization; a NULL taskId is allowed for org-level blobs.
	insert: `INSERT INTO blobs (
		organization_id, task_id, kind, content_type, byte_size, sha256, bytes
	)
	SELECT $1::uuid, $2::uuid, $3, $4, $5::int, $6, $7::bytea
	WHERE $2::uuid IS NULL
	   OR EXISTS (
			SELECT 1 FROM tasks t
			WHERE t.id = $2::uuid AND t.organization_id = $1::uuid
	   )
	ON CONFLICT (organization_id, sha256) DO NOTHING
	RETURNING ${BLOB_COLUMNS}`,
	selectBySha: `SELECT ${BLOB_COLUMNS} FROM blobs
		WHERE organization_id = $1::uuid AND sha256 = $2`,
	getBySha: `SELECT ${BLOB_COLUMNS}, bytes FROM blobs
		WHERE organization_id = $1::uuid AND sha256 = $2`,
} as const;

export class PostgresBlobStore implements BlobStore {
	constructor(private readonly sql: PgSql) {}

	async put(input: BlobStorePutInput): Promise<BlobRef> {
		const validated = validateBlobPutInput(input);
		const rows = (await this.sql.unsafe(STMT.insert, [
			validated.organizationId,
			validated.taskId,
			validated.kind,
			validated.contentType,
			validated.byteSize,
			validated.sha256,
			validated.bytes,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			// Either the conflict target already held the bytes (dedupe) or the
			// task guard matched nothing. Only the former is success.
			const existing = (await this.sql.unsafe(STMT.selectBySha, [
				validated.organizationId,
				validated.sha256,
			])) as unknown as Record<string, unknown>[];
			if (existing.length === 0) {
				throw new BlobStoreError(
					"TASK_NOT_FOUND",
					"taskId is not a task in this organization",
				);
			}
		}
		return {
			storageRef: formatBlobStorageRef(validated.sha256),
			byteSize: validated.byteSize,
			sha256: validated.sha256,
		};
	}

	async get(input: BlobStoreGetInput): Promise<BlobStoreValue | null> {
		if (
			typeof input.organizationId !== "string" ||
			input.organizationId.length === 0
		) {
			return null;
		}
		const sha256 = parseBlobStorageRef(input.storageRef);
		if (sha256 === null) return null;
		const rows = (await this.sql.unsafe(STMT.getBySha, [
			input.organizationId,
			sha256,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) return null;
		const row = rows[0];
		return {
			bytes: toBytes(row.bytes),
			contentType: row.content_type as string,
			sha256: row.sha256 as string,
		};
	}
}

/** postgres.js returns bytea as a Buffer; normalize to a plain Uint8Array. */
function toBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return new Uint8Array(value);
	throw new Error("blob bytes column is not a byte array");
}
