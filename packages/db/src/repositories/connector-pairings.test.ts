import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { asOrganizationId, PlatformError } from "@isolate/shared";
import type { PgSql } from "../client";
import { InMemoryConnectorPairingRepository } from "../testing/connector-pairings-fake";
import {
	type ConnectorPairingRecord,
	type CreateConnectorPairingInput,
	mapConnectorPairingRow,
	normalizeConnectorPairingCodeHash,
	PostgresConnectorPairingRepository,
	toConnectorPairingSummary,
} from "./connector-pairings";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const DEVICE_A = "33333333-3333-4333-8333-333333333333";
const DEVICE_B = "44444444-4444-4444-8444-444444444444";
const PAIRING_ID = "55555555-5555-4555-8555-555555555555";

/** Hash-shaped fixtures are built at runtime, never as static literals. */
function randomHash(): string {
	return createHash("sha256").update(crypto.randomUUID()).digest("hex");
}

function future(offsetMs = 600_000): Date {
	return new Date(Date.now() + offsetMs);
}

function createInput(
	overrides: Partial<CreateConnectorPairingInput> = {},
): CreateConnectorPairingInput {
	return {
		organizationId: ORG_A,
		deviceId: DEVICE_A,
		connectorId: "sentry",
		displayName: "Sentry production",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/prod",
		scopes: ["event:read", "project:read"],
		codeHash: randomHash(),
		expiresAt: future(),
		...overrides,
	};
}

const row: Record<string, unknown> = {
	id: PAIRING_ID,
	organization_id: ORG_A,
	device_id: DEVICE_A,
	connector_id: "sentry",
	display_name: "Sentry production",
	auth_kind: "api_key",
	credential_ref: "keychain:isolate/sentry/prod",
	scopes: ["event:read"],
	metadata: { credentialId: "66666666-6666-4666-8666-666666666666" },
	code_hash: "a".repeat(64),
	status: "pending",
	created_by: null,
	expires_at: new Date("2026-11-02T12:10:00.000Z"),
	claimed_at: null,
	completed_at: null,
	created_at: new Date("2026-11-02T12:00:00.000Z"),
	updated_at: new Date("2026-11-02T12:00:00.000Z"),
};

describe("in-memory connector pairing repository", () => {
	test("create returns a summary without the code hash", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		const input = createInput();
		const created = await repo.create(input);
		expect(created.id).toBeTruthy();
		expect(created.status).toBe("pending");
		expect(created.scopes).toEqual(["event:read", "project:read"]);
		expect(Object.keys(created)).not.toContain("codeHash");
		const serialized = JSON.stringify(created);
		expect(serialized).not.toContain(input.codeHash);
		expect(serialized).not.toContain("code");
	});

	test("the claim is atomic: the second relay gets nothing", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		const input = createInput();
		await repo.create(input);
		const first = await repo.claimByCodeHash(ORG_A, DEVICE_A, input.codeHash);
		expect(first?.status).toBe("claimed");
		expect(first?.claimedAt).not.toBeNull();
		expect(
			await repo.claimByCodeHash(ORG_A, DEVICE_A, input.codeHash),
		).toBeNull();
		// Repeating the claim on a completed session is still a non-match.
		await repo.complete(ORG_A, first?.id ?? "", {
			credentialId: "66666666-6666-4666-8666-666666666666",
		});
		expect(
			await repo.claimByCodeHash(ORG_A, DEVICE_A, input.codeHash),
		).toBeNull();
	});

	test("an expired code never claims and can be marked expired", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		const input = createInput({
			expiresAt: new Date(Date.now() - 1_000),
		});
		const created = await repo.create(input);
		expect(
			await repo.claimByCodeHash(ORG_A, DEVICE_A, input.codeHash),
		).toBeNull();
		const expired = await repo.expire(ORG_A, created.id);
		expect(expired?.status).toBe("expired");
		expect(await repo.expire(ORG_A, created.id)).toBeNull();
	});

	test("claim is scoped by organization and device", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		const input = createInput();
		await repo.create(input);
		expect(
			await repo.claimByCodeHash(ORG_B, DEVICE_A, input.codeHash),
		).toBeNull();
		expect(
			await repo.claimByCodeHash(ORG_A, DEVICE_B, input.codeHash),
		).toBeNull();
		const claimed = await repo.claimByCodeHash(ORG_A, DEVICE_A, input.codeHash);
		expect(claimed?.status).toBe("claimed");
	});

	test("complete only moves a claimed session and merges metadata", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		const input = createInput();
		const created = await repo.create(input);
		expect(
			await repo.complete(ORG_A, created.id, {
				credentialId: "66666666-6666-4666-8666-666666666666",
			}),
		).toBeNull();
		await repo.claimByCodeHash(ORG_A, DEVICE_A, input.codeHash);
		expect(
			await repo.complete(ORG_B, created.id, {
				credentialId: "66666666-6666-4666-8666-666666666666",
			}),
		).toBeNull();
		const completed = await repo.complete(ORG_A, created.id, {
			credentialId: "66666666-6666-4666-8666-666666666666",
		});
		expect(completed?.status).toBe("completed");
		expect(completed?.metadata.credentialId).toBe(
			"66666666-6666-4666-8666-666666666666",
		);
		expect(completed?.completedAt).not.toBeNull();
	});

	test("cancel and expire are terminal and tenant-scoped", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		const first = await repo.create(createInput());
		expect(await repo.cancel(ORG_B, first.id)).toBeNull();
		const cancelled = await repo.cancel(ORG_A, first.id);
		expect(cancelled?.status).toBe("cancelled");
		expect(await repo.cancel(ORG_A, first.id)).toBeNull();

		const second = await repo.create(createInput());
		expect(await repo.expire(ORG_A, second.id)).toBeNull();
		await repo.cancel(ORG_A, second.id);
		expect(await repo.expire(ORG_A, second.id)).toBeNull();
	});

	test("lists are tenant-scoped and bounded", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		await repo.create(createInput({ displayName: "First" }));
		await repo.create(createInput({ displayName: "Second" }));
		await repo.create(
			createInput({ organizationId: ORG_B, displayName: "Other org" }),
		);
		expect(await repo.findByOrganization(ORG_A)).toHaveLength(2);
		expect(await repo.findByOrganization(ORG_B)).toHaveLength(1);
		expect(await repo.findByOrganization(ORG_A, 1)).toHaveLength(1);
		expect(await repo.get(ORG_B, "missing")).toBeNull();
		expect(repo.rowCount).toBe(3);
	});

	test("rejects malformed code hashes and unsafe metadata", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		for (const invalid of ["", "abc", "A".repeat(64), `${"a".repeat(65)}`]) {
			await expect(
				repo.create(createInput({ codeHash: invalid })),
			).rejects.toBeInstanceOf(PlatformError);
		}
		await expect(
			repo.create(
				createInput({ metadata: { apiKey: `sk-${"a".repeat(32)}` } }),
			),
		).rejects.toBeInstanceOf(PlatformError);
	});
});

describe("Postgres connector pairing repository", () => {
	test("maps the row and drops the hash from the summary", () => {
		const mapped = mapConnectorPairingRow(row);
		expect(mapped.codeHash).toBe("a".repeat(64));
		expect(mapped.scopes).toEqual(["event:read"]);
		const summary = toConnectorPairingSummary(mapped);
		expect(JSON.stringify(summary)).not.toContain("a".repeat(64));
		expect(() =>
			mapConnectorPairingRow({ ...row, code_hash: "not-a-hash" }),
		).toThrow(PlatformError);
	});

	test("create writes only the hash and tenant metadata", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				return [row];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorPairingRepository(sql);
		const input = createInput();
		await repo.create(input);
		expect(calls[0].query).toContain("INSERT INTO connector_pairings");
		expect(calls[0].query).toContain("code_hash");
		expect(calls[0].params).toContain(input.codeHash);
		expect(calls[0].params).not.toContain("sentry-secret");
	});

	test("claim is one conditional UPDATE scoped by org, device and expiry", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				return [];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorPairingRepository(sql);
		const now = new Date("2026-11-02T12:00:00.000Z");
		const hash = randomHash();
		expect(await repo.claimByCodeHash(ORG_A, DEVICE_A, hash, now)).toBeNull();
		expect(calls[0].query).toContain("UPDATE connector_pairings");
		expect(calls[0].query).toContain("status = 'claimed'");
		expect(calls[0].query).toContain("organization_id = $1");
		expect(calls[0].query).toContain("device_id = $2");
		expect(calls[0].query).toContain("code_hash = $3");
		expect(calls[0].query).toContain("status = 'pending'");
		expect(calls[0].query).toContain("expires_at > $4::timestamptz");
		expect(calls[0].params).toEqual([ORG_A, DEVICE_A, hash, now.toISOString()]);
	});

	test("complete, cancel and expire are conditional and tenant-scoped", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				return [];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorPairingRepository(sql);
		const now = new Date("2026-11-02T12:00:00.000Z");
		await repo.complete(ORG_A, PAIRING_ID, { credentialId: PAIRING_ID }, now);
		expect(calls[0].query).toContain("status = 'completed'");
		expect(calls[0].query).toContain("status = 'claimed'");
		expect(calls[0].query).toContain("metadata = metadata || $4::text::jsonb");
		await repo.cancel(ORG_A, PAIRING_ID, now);
		expect(calls[1].query).toContain("status = 'cancelled'");
		expect(calls[1].query).toContain("status IN ('pending', 'claimed')");
		await repo.expire(ORG_A, PAIRING_ID, now);
		expect(calls[2].query).toContain("status = 'expired'");
		expect(calls[2].query).toContain("expires_at <= $3::timestamptz");
		for (const call of calls) {
			expect(call.query).toContain("organization_id = $1");
		}
	});

	test("code hashes are validated before any SQL", () => {
		expect(() => normalizeConnectorPairingCodeHash("abc")).toThrow(
			PlatformError,
		);
		expect(normalizeConnectorPairingCodeHash("a".repeat(64))).toBe(
			"a".repeat(64),
		);
	});

	test("insert into the fake cannot reuse a code hash", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		const input = createInput();
		await repo.create(input);
		await expect(repo.create(input)).rejects.toBeInstanceOf(PlatformError);
	});
});

describe("pairing records stay metadata-only", () => {
	test("summaries never expose a code hash or a secret field", async () => {
		const repo = new InMemoryConnectorPairingRepository();
		const created = await repo.create(createInput());
		const keys = Object.keys(created);
		expect(keys).not.toContain("codeHash");
		expect(keys).not.toContain("secret");
		expect(keys).not.toContain("token");
		const record: ConnectorPairingRecord = mapConnectorPairingRow(row);
		expect(record.codeHash).toHaveLength(64);
	});
});
