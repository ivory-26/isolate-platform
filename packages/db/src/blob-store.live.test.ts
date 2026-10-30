import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { asOrganizationId } from "@isolate/shared";
import { createDb } from "./client";
import {
	BlobStoreError,
	formatBlobStorageRef,
	MAX_BLOB_BYTES,
	PostgresBlobStore,
} from "./repositories/blob-store";

/**
 * Live round-trip for the wave-11 blob store. Auto-skips without DATABASE_URL
 * and also skips when `0008_blob_store.sql` has not been applied yet (the lane
 * never applies migrations; the coordinator does).
 *
 * Verified here: bytea binding and read-back, `octet_length(bytes)` equals
 * `byte_size`, one row per (organization, digest) on dedupe, tenant isolation
 * on get, and the 2 MiB gate rejecting before any write.
 *
 * Every value is a bound parameter and no environment value is printed.
 */
const hasDb =
	typeof process.env.DATABASE_URL === "string" &&
	process.env.DATABASE_URL.length > 0;

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

test.skipIf(!hasDb)(
	"Neon live: blob store round-trip, dedupe, tenant isolation, oversize gate",
	async () => {
		const url = process.env.DATABASE_URL;
		if (!url) throw new Error("DATABASE_URL is required for live tests");
		const sql = createDb(url, { max: 2 });
		const unique = crypto.randomUUID().slice(0, 8);
		const slugA = `live-w11blob-a-${unique}`;
		const slugB = `live-w11blob-b-${unique}`;
		let orgUuids: string[] = [];

		try {
			const ready = (await sql.unsafe(
				"SELECT to_regclass('public.blobs') IS NOT NULL AS present",
				[],
			)) as Array<Record<string, unknown>>;
			if (ready[0]?.present !== true) {
				return; // 0008 not applied: clean skip
			}

			const orgRows = (await sql.unsafe(
				`INSERT INTO organizations (name, slug) VALUES ($1, $1), ($2, $2)
				 RETURNING id, slug`,
				[slugA, slugB],
			)) as Array<Record<string, unknown>>;
			orgUuids = orgRows.map((row) => row.id as string);
			const orgA = asOrganizationId(
				orgRows.find((row) => row.slug === slugA)?.id as string,
			);
			const orgB = asOrganizationId(
				orgRows.find((row) => row.slug === slugB)?.id as string,
			);
			const store = new PostgresBlobStore(sql);

			const bytes = new TextEncoder().encode(
				"diff --git a/x b/x\n+hello blob\n",
			);
			const sha256 = sha256Hex(bytes);
			const ref = await store.put({
				organizationId: orgA,
				taskId: null,
				kind: "diff",
				contentType: "text/x-diff",
				bytes,
				sha256,
			});
			expect(ref).toEqual({
				storageRef: formatBlobStorageRef(sha256),
				byteSize: bytes.byteLength,
				sha256,
			});
			expect(ref.storageRef).toBe(`blob:${sha256}`);

			// Round-trip: the exact bytes and metadata come back.
			const fetched = await store.get({
				organizationId: orgA,
				storageRef: ref.storageRef,
			});
			expect(fetched).not.toBeNull();
			if (fetched) {
				expect(Array.from(fetched.bytes)).toEqual(Array.from(bytes));
				expect(fetched.contentType).toBe("text/x-diff");
				expect(fetched.sha256).toBe(sha256);
			}

			// Stored length must match the declared size at the database level.
			const stored = (await sql.unsafe(
				`SELECT count(*)::int AS n,
				        min(octet_length(bytes))::int AS octets,
				        min(byte_size)::int AS declared
				 FROM blobs
				 WHERE organization_id = $1::uuid AND sha256 = $2`,
				[orgA, sha256],
			)) as Array<Record<string, unknown>>;
			expect(Number(stored[0]?.n)).toBe(1);
			expect(Number(stored[0]?.octets)).toBe(bytes.byteLength);
			expect(Number(stored[0]?.declared)).toBe(bytes.byteLength);

			// Foreign tenant: same ref, indistinguishable from absent.
			expect(
				await store.get({ organizationId: orgB, storageRef: ref.storageRef }),
			).toBeNull();

			// Dedupe: a second put resolves to the same row, not a duplicate.
			const replay = await store.put({
				organizationId: orgA,
				taskId: null,
				kind: "report",
				contentType: "application/octet-stream",
				bytes: new TextEncoder().encode("later bytes win nothing"),
				sha256,
			});
			expect(replay.storageRef).toBe(ref.storageRef);
			const deduped = (await sql.unsafe(
				"SELECT count(*)::int AS n FROM blobs WHERE organization_id = $1::uuid AND sha256 = $2",
				[orgA, sha256],
			)) as Array<Record<string, unknown>>;
			expect(Number(deduped[0]?.n)).toBe(1);

			// A task outside the organization (here: nonexistent) is rejected.
			const orphanSha = sha256Hex(encoderBytes("orphan"));
			let orphanCode: string | null = null;
			try {
				await store.put({
					organizationId: orgA,
					taskId: crypto.randomUUID(),
					kind: "log_bundle",
					contentType: "text/plain",
					bytes: encoderBytes("orphan"),
					sha256: orphanSha,
				});
			} catch (error) {
				orphanCode =
					error instanceof BlobStoreError ? error.code : "NOT_BLOB_STORE_ERROR";
			}
			expect(orphanCode).toBe("TASK_NOT_FOUND");

			// Oversize is rejected before the INSERT: no row appears.
			const oversize = new Uint8Array(MAX_BLOB_BYTES + 1);
			const oversizeSha = sha256Hex(oversize);
			let oversizeCode: string | null = null;
			try {
				await store.put({
					organizationId: orgA,
					taskId: null,
					kind: "log_bundle",
					contentType: "application/octet-stream",
					bytes: oversize,
					sha256: oversizeSha,
				});
			} catch (error) {
				oversizeCode =
					error instanceof BlobStoreError ? error.code : "NOT_BLOB_STORE_ERROR";
			}
			expect(oversizeCode).toBe("BYTES_TOO_LARGE");
			const afterOversize = (await sql.unsafe(
				"SELECT count(*)::int AS n FROM blobs WHERE organization_id = $1::uuid AND sha256 = $2",
				[orgA, oversizeSha],
			)) as Array<Record<string, unknown>>;
			expect(Number(afterOversize[0]?.n)).toBe(0);
		} finally {
			for (const uuid of orgUuids) {
				try {
					await sql.unsafe(
						"DELETE FROM blobs WHERE organization_id = $1::uuid",
						[uuid],
					);
				} catch {
					// Best effort only; cleanup must not mask the test failure.
				}
			}
			for (const uuid of orgUuids) {
				try {
					await sql.unsafe("DELETE FROM organizations WHERE id = $1::uuid", [
						uuid,
					]);
				} catch {
					// Best effort only.
				}
			}
			await sql.end({ timeout: 5 });
		}
	},
	120000,
);

function encoderBytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}
