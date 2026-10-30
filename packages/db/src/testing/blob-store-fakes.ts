import type {
	BlobKind,
	BlobRef,
	BlobStore,
	BlobStoreGetInput,
	BlobStorePutInput,
	BlobStoreValue,
} from "@isolate/shared";
import {
	formatBlobStorageRef,
	parseBlobStorageRef,
	validateBlobPutInput,
} from "../repositories/blob-store";

/**
 * Offline twin of `PostgresBlobStore` for tests and the worker's disabled-
 * provider path. Same contract: per-tenant dedupe on the digest, defensive
 * byte copies, and `null` for absent or foreign references.
 */
type StoredBlob = {
	readonly organizationId: string;
	readonly taskId: string | null;
	readonly kind: BlobKind;
	readonly contentType: string;
	readonly bytes: Uint8Array;
	readonly sha256: string;
};

function keyOf(organizationId: string, sha256: string): string {
	return `${organizationId}:${sha256}`;
}

export class InMemoryBlobStore implements BlobStore {
	private readonly rows = new Map<string, StoredBlob>();

	async put(input: BlobStorePutInput): Promise<BlobRef> {
		const validated = validateBlobPutInput(input);
		const key = keyOf(validated.organizationId, validated.sha256);
		const existing = this.rows.get(key);
		if (existing !== undefined) {
			return {
				storageRef: formatBlobStorageRef(existing.sha256),
				byteSize: existing.bytes.byteLength,
				sha256: existing.sha256,
			};
		}
		const row: StoredBlob = {
			organizationId: validated.organizationId,
			taskId: validated.taskId,
			kind: validated.kind,
			contentType: validated.contentType,
			bytes: new Uint8Array(validated.bytes),
			sha256: validated.sha256,
		};
		this.rows.set(key, row);
		return {
			storageRef: formatBlobStorageRef(row.sha256),
			byteSize: row.bytes.byteLength,
			sha256: row.sha256,
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
		const row = this.rows.get(keyOf(input.organizationId, sha256));
		if (row === undefined) return null;
		return {
			bytes: new Uint8Array(row.bytes),
			contentType: row.contentType,
			sha256: row.sha256,
		};
	}

	/** Test-only visibility into storage (one entry per tenant/digest). */
	count(): number {
		return this.rows.size;
	}

	countForOrganization(organizationId: string): number {
		let total = 0;
		for (const row of this.rows.values()) {
			if (row.organizationId === organizationId) total += 1;
		}
		return total;
	}
}
