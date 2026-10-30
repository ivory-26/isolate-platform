import { describe, expect, test } from "bun:test";
import type { BlobKind, BlobStorePutInput } from "@isolate/shared";
import type { PgSql } from "../client";
import { InMemoryBlobStore } from "../testing/blob-store-fakes";
import {
	BlobStoreError,
	formatBlobStorageRef,
	MAX_BLOB_BYTES,
	PostgresBlobStore,
	parseBlobStorageRef,
	validateBlobPutInput,
} from "./blob-store";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const SHA = "a".repeat(64);
const encoder = new TextEncoder();

function input(overrides: Partial<BlobStorePutInput> = {}): BlobStorePutInput {
	return {
		organizationId: ORG_A,
		taskId: null,
		kind: "diff",
		contentType: "text/x-diff",
		bytes: encoder.encode("diff --git a/x b/x\n+hello\n"),
		sha256: SHA,
		...overrides,
	};
}

function codeOf(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return error instanceof BlobStoreError
			? error.code
			: "NOT_BLOB_STORE_ERROR";
	}
}

describe("blob storage ref format/parse", () => {
	test("round-trips blob:<sha256>", () => {
		const ref = formatBlobStorageRef(SHA);
		expect(ref).toBe(`blob:${SHA}`);
		expect(parseBlobStorageRef(ref)).toBe(SHA);
	});

	test("refuses to format an invalid digest", () => {
		expect(codeOf(() => formatBlobStorageRef("A".repeat(64)))).toBe(
			"INVALID_INPUT",
		);
		expect(codeOf(() => formatBlobStorageRef("a".repeat(63)))).toBe(
			"INVALID_INPUT",
		);
	});

	test("parses only blob:<64 lowercase hex>", () => {
		expect(parseBlobStorageRef(`inline:${SHA}`)).toBeNull();
		expect(parseBlobStorageRef(`blob:${SHA.toUpperCase()}`)).toBeNull();
		expect(parseBlobStorageRef(`blob:${SHA}0`)).toBeNull();
		expect(parseBlobStorageRef(`blob:${SHA.slice(1)}`)).toBeNull();
		expect(parseBlobStorageRef("blob:")).toBeNull();
		expect(parseBlobStorageRef(` ${formatBlobStorageRef(SHA)}`)).toBeNull();
		expect(parseBlobStorageRef("")).toBeNull();
	});
});

describe("validateBlobPutInput (bounds and shape)", () => {
	test("accepts exactly 2 MiB and reports the byte size", () => {
		const validated = validateBlobPutInput(
			input({ bytes: new Uint8Array(MAX_BLOB_BYTES) }),
		);
		expect(validated.byteSize).toBe(MAX_BLOB_BYTES);
		expect(MAX_BLOB_BYTES).toBe(2097152);
	});

	test("rejects one byte over 2 MiB before any write", () => {
		expect(
			codeOf(() =>
				validateBlobPutInput(
					input({ bytes: new Uint8Array(MAX_BLOB_BYTES + 1) }),
				),
			),
		).toBe("BYTES_TOO_LARGE");
	});

	test("accepts an empty blob at the lower bound", () => {
		expect(
			validateBlobPutInput(input({ bytes: new Uint8Array(0) })).byteSize,
		).toBe(0);
	});

	test("rejects malformed structural input", () => {
		expect(
			codeOf(() => validateBlobPutInput(input({ organizationId: "" }))),
		).toBe("INVALID_INPUT");
		expect(codeOf(() => validateBlobPutInput(input({ taskId: "" })))).toBe(
			"INVALID_INPUT",
		);
		expect(
			codeOf(() => validateBlobPutInput(input({ kind: "patch" as BlobKind }))),
		).toBe("INVALID_INPUT");
		expect(codeOf(() => validateBlobPutInput(input({ contentType: "" })))).toBe(
			"INVALID_INPUT",
		);
		expect(
			codeOf(() =>
				validateBlobPutInput(input({ contentType: "x".repeat(129) })),
			),
		).toBe("INVALID_INPUT");
		expect(codeOf(() => validateBlobPutInput(input({ sha256: "zz" })))).toBe(
			"INVALID_INPUT",
		);
		expect(
			codeOf(() =>
				validateBlobPutInput(
					input({ bytes: "not-bytes" as unknown as Uint8Array }),
				),
			),
		).toBe("INVALID_INPUT");
	});

	test("accepts all four blob kinds and a 128-char content type", () => {
		for (const kind of [
			"diff",
			"log_bundle",
			"report",
			"screenshot",
		] as const) {
			expect(validateBlobPutInput(input({ kind })).kind).toBe(kind);
		}
		expect(
			validateBlobPutInput(input({ contentType: "x".repeat(128) })).contentType
				.length,
		).toBe(128);
	});
});

describe("InMemoryBlobStore (BlobStore contract)", () => {
	test("puts and gets bytes tenant-scoped with the blob:<sha> ref", async () => {
		const store = new InMemoryBlobStore();
		const bytes = encoder.encode("+hello blob\n");
		const ref = await store.put(input({ bytes }));
		expect(ref).toEqual({
			storageRef: `blob:${SHA}`,
			byteSize: bytes.byteLength,
			sha256: SHA,
		});

		const value = await store.get({
			organizationId: ORG_A,
			storageRef: ref.storageRef,
		});
		expect(value).not.toBeNull();
		expect(value?.contentType).toBe("text/x-diff");
		expect(value?.sha256).toBe(SHA);
		expect(Array.from(value?.bytes ?? [])).toEqual(Array.from(bytes));
	});

	test("dedupes on (organization_id, sha256) and keeps the first row", async () => {
		const store = new InMemoryBlobStore();
		const first = await store.put(input());
		const replay = await store.put(
			input({
				contentType: "application/octet-stream",
				bytes: encoder.encode("different bytes"),
			}),
		);
		expect(store.count()).toBe(1);
		expect(store.countForOrganization(ORG_A)).toBe(1);
		expect(replay.storageRef).toBe(first.storageRef);
		const value = await store.get({
			organizationId: ORG_A,
			storageRef: first.storageRef,
		});
		expect(value?.contentType).toBe("text/x-diff");
	});

	test("the same digest for two organizations is isolated", async () => {
		const store = new InMemoryBlobStore();
		await store.put(input({ bytes: encoder.encode("org a") }));
		const valueB = await store.get({
			organizationId: ORG_B,
			storageRef: formatBlobStorageRef(SHA),
		});
		expect(valueB).toBeNull();

		await store.put(
			input({
				organizationId: ORG_B,
				contentType: "text/plain",
				bytes: encoder.encode("org b"),
			}),
		);
		expect(store.countForOrganization(ORG_A)).toBe(1);
		expect(store.countForOrganization(ORG_B)).toBe(1);
		const a = await store.get({
			organizationId: ORG_A,
			storageRef: formatBlobStorageRef(SHA),
		});
		const b = await store.get({
			organizationId: ORG_B,
			storageRef: formatBlobStorageRef(SHA),
		});
		expect(new TextDecoder().decode(a?.bytes)).toBe("org a");
		expect(new TextDecoder().decode(b?.bytes)).toBe("org b");
	});

	test("returns null for absent digests and malformed refs", async () => {
		const store = new InMemoryBlobStore();
		await store.put(input());
		expect(
			await store.get({
				organizationId: ORG_A,
				storageRef: formatBlobStorageRef("b".repeat(64)),
			}),
		).toBeNull();
		expect(
			await store.get({ organizationId: ORG_A, storageRef: `inline:${SHA}` }),
		).toBeNull();
		expect(
			await store.get({ organizationId: ORG_A, storageRef: "blob:nothex" }),
		).toBeNull();
	});

	test("rejects oversize and invalid input without storing anything", async () => {
		const store = new InMemoryBlobStore();
		await expect(
			store.put(input({ bytes: new Uint8Array(MAX_BLOB_BYTES + 1) })),
		).rejects.toBeInstanceOf(BlobStoreError);
		await expect(store.put(input({ sha256: "short" }))).rejects.toBeInstanceOf(
			BlobStoreError,
		);
		expect(store.count()).toBe(0);
		expect(
			await store.get({
				organizationId: ORG_A,
				storageRef: formatBlobStorageRef(SHA),
			}),
		).toBeNull();
	});

	test("copies bytes on write and read so callers cannot alias storage", async () => {
		const store = new InMemoryBlobStore();
		const bytes = encoder.encode("original");
		await store.put(input({ bytes }));
		bytes[0] = 0;

		const first = await store.get({
			organizationId: ORG_A,
			storageRef: formatBlobStorageRef(SHA),
		});
		expect(new TextDecoder().decode(first?.bytes)).toBe("original");
		if (first) first.bytes[0] = 0;

		const second = await store.get({
			organizationId: ORG_A,
			storageRef: formatBlobStorageRef(SHA),
		});
		expect(new TextDecoder().decode(second?.bytes)).toBe("original");
	});

	test("treats an invalid organization as a miss, not a cross-tenant hit", async () => {
		const store = new InMemoryBlobStore();
		await store.put(input());
		expect(
			await store.get({
				organizationId: "",
				storageRef: formatBlobStorageRef(SHA),
			}),
		).toBeNull();
	});
});

describe("PostgresBlobStore (statement shape and fail-closed branches)", () => {
	type Call = {
		readonly statement: string;
		readonly params: readonly unknown[];
	};

	function scriptedSql(
		responses: readonly (readonly Record<string, unknown>[])[],
	): { sql: PgSql; calls: Call[] } {
		const queue = [...responses];
		const calls: Call[] = [];
		const sql = {
			unsafe: async (statement: string, params: unknown[] = []) => {
				calls.push({ statement, params });
				return queue.shift() ?? [];
			},
		} as unknown as PgSql;
		return { sql, calls };
	}

	test("put binds the tenant, digest, byte size and raw bytes with ON CONFLICT DO NOTHING", async () => {
		const { sql, calls } = scriptedSql([[{ sha256: SHA }]]);
		const store = new PostgresBlobStore(sql);
		const bytes = encoder.encode("payload");
		const ref = await store.put(input({ bytes }));
		expect(ref).toEqual({
			storageRef: `blob:${SHA}`,
			byteSize: bytes.byteLength,
			sha256: SHA,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].statement).toContain(
			"ON CONFLICT (organization_id, sha256) DO NOTHING",
		);
		expect(calls[0].statement).toContain("EXISTS");
		expect(calls[0].params[0]).toBe(ORG_A);
		expect(calls[0].params[1]).toBeNull();
		expect(calls[0].params[2]).toBe("diff");
		expect(calls[0].params[3]).toBe("text/x-diff");
		expect(calls[0].params[4]).toBe(bytes.byteLength);
		expect(calls[0].params[5]).toBe(SHA);
		expect(calls[0].params[6]).toBe(bytes);
	});

	test("an empty insert followed by a matching row is a dedupe success", async () => {
		const { sql, calls } = scriptedSql([[], [{ sha256: SHA }]]);
		const store = new PostgresBlobStore(sql);
		await expect(store.put(input())).resolves.toMatchObject({
			storageRef: `blob:${SHA}`,
		});
		expect(calls).toHaveLength(2);
		expect(calls[1].params).toEqual([ORG_A, SHA]);
	});

	test("an empty insert with no existing row fails closed as TASK_NOT_FOUND", async () => {
		const { sql, calls } = scriptedSql([[], []]);
		const store = new PostgresBlobStore(sql);
		await expect(
			store.put(input({ taskId: crypto.randomUUID() })),
		).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
		expect(calls).toHaveLength(2);
	});

	test("oversize input never reaches SQL", async () => {
		const { sql, calls } = scriptedSql([]);
		const store = new PostgresBlobStore(sql);
		await expect(
			store.put(input({ bytes: new Uint8Array(MAX_BLOB_BYTES + 1) })),
		).rejects.toMatchObject({ code: "BYTES_TOO_LARGE" });
		expect(calls).toHaveLength(0);
	});

	test("get skips SQL for malformed refs and maps a hit", async () => {
		const { sql, calls } = scriptedSql([
			[
				{
					sha256: SHA,
					content_type: "text/plain",
					bytes: encoder.encode("hi"),
				},
			],
		]);
		const store = new PostgresBlobStore(sql);
		expect(
			await store.get({ organizationId: ORG_A, storageRef: "inline:abc" }),
		).toBeNull();
		expect(calls).toHaveLength(0);

		const hit = await store.get({
			organizationId: ORG_A,
			storageRef: `blob:${SHA}`,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].params).toEqual([ORG_A, SHA]);
		expect(hit?.contentType).toBe("text/plain");
		expect(new TextDecoder().decode(hit?.bytes)).toBe("hi");
	});

	test("get returns null on an empty result (foreign org is indistinguishable)", async () => {
		const { sql } = scriptedSql([[]]);
		const store = new PostgresBlobStore(sql);
		expect(
			await store.get({
				organizationId: ORG_B,
				storageRef: formatBlobStorageRef(SHA),
			}),
		).toBeNull();
	});
});
