import { describe, expect, test } from "bun:test";
import { asOrganizationId, PlatformError } from "@isolate/shared";
import type { PgSql } from "../client";
import { InMemoryConnectorDeviceRepository } from "../testing/connector-devices-fake";
import {
	type CreateConnectorDeviceInput,
	mapConnectorDeviceRow,
	PostgresConnectorDeviceRepository,
} from "./connector-devices";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";

function createInput(
	overrides: Partial<CreateConnectorDeviceInput> = {},
): CreateConnectorDeviceInput {
	return {
		organizationId: ORG_A,
		displayName: "Sahil's laptop",
		tokenHash: HASH_A,
		status: "active",
		...overrides,
	};
}

const row: Record<string, unknown> = {
	id: DEVICE_ID,
	organization_id: ORG_A,
	user_id: null,
	display_name: "Sahil's laptop",
	token_hash: HASH_A,
	status: "active",
	last_seen_at: null,
	created_at: new Date("2026-10-31T11:00:00.000Z"),
	updated_at: new Date("2026-10-31T12:00:00.000Z"),
};

describe("in-memory connector device repository", () => {
	test("create returns a summary without the token hash", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		const summary = await repo.create(createInput());
		expect(summary.displayName).toBe("Sahil's laptop");
		expect(summary.status).toBe("active");
		expect(summary.userId).toBeNull();
		expect(Object.keys(summary)).not.toContain("tokenHash");
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain(HASH_A);
		expect(serialized).not.toContain("hash");
	});

	test("defaults to pending and enforces per-tenant unique names", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		const pending = await repo.create(
			createInput({ status: undefined, tokenHash: HASH_A }),
		);
		expect(pending.status).toBe("pending");
		await expect(
			repo.create(createInput({ tokenHash: HASH_B })),
		).rejects.toBeInstanceOf(PlatformError);
		const otherOrg = await repo.create(
			createInput({ organizationId: ORG_B, tokenHash: HASH_B }),
		);
		expect(otherOrg.organizationId).toBe(ORG_B);
		expect(repo.rowCount).toBe(2);
	});

	test("token hashes are globally unique", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		await repo.create(createInput());
		await expect(
			repo.create(
				createInput({ displayName: "Second laptop", tokenHash: HASH_A }),
			),
		).rejects.toBeInstanceOf(PlatformError);
	});

	test("verify returns only an active device with a matching hash", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		const created = await repo.create(createInput());
		const verified = await repo.verifyByTokenHash(ORG_A, HASH_A);
		expect(verified?.id).toBe(created.id);
		expect(verified?.status).toBe("active");
		expect(await repo.verifyByTokenHash(ORG_A, HASH_B)).toBeNull();
		expect(await repo.verifyByTokenHash(ORG_B, HASH_A)).toBeNull();
	});

	test("pending and revoked devices never verify", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		await repo.create(createInput({ status: "pending" }));
		expect(await repo.verifyByTokenHash(ORG_A, HASH_A)).toBeNull();
		const active = await repo.create(
			createInput({ displayName: "Active", tokenHash: HASH_B }),
		);
		expect(await repo.verifyByTokenHash(ORG_A, HASH_B)).not.toBeNull();
		await repo.revoke(ORG_A, active.id);
		expect(await repo.verifyByTokenHash(ORG_A, HASH_B)).toBeNull();
	});

	test("malformed token hashes are a boundary error", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		for (const invalid of ["", "abc", "A".repeat(64), `${HASH_A}0`]) {
			await expect(
				repo.create(createInput({ tokenHash: invalid })),
			).rejects.toBeInstanceOf(PlatformError);
			await expect(
				repo.verifyByTokenHash(ORG_A, invalid),
			).rejects.toBeInstanceOf(PlatformError);
		}
	});

	test("touchSeen is tenant-scoped and rejects invalid timestamps", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		const created = await repo.create(createInput());
		const seenAt = new Date("2026-10-31T12:05:00.000Z");
		expect(await repo.touchSeen(ORG_B, created.id, seenAt)).toBeNull();
		expect(
			(await repo.touchSeen(ORG_A, created.id, seenAt))?.lastSeenAt,
		).toEqual(seenAt);
		await expect(
			repo.touchSeen(ORG_A, created.id, new Date(Number.NaN)),
		).rejects.toBeInstanceOf(PlatformError);
	});

	test("revoke is tenant-scoped and lists stay tenant-scoped and sorted", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		await repo.create(createInput());
		const second = await repo.create(
			createInput({ displayName: "Another device", tokenHash: HASH_B }),
		);
		await repo.create(
			createInput({
				organizationId: ORG_B,
				displayName: "Other org device",
				tokenHash: "c".repeat(64),
			}),
		);
		expect(await repo.revoke(ORG_B, second.id)).toBeNull();
		const revoked = await repo.revoke(ORG_A, second.id);
		expect(revoked?.status).toBe("revoked");
		const names = (await repo.listByOrganization(ORG_A)).map(
			(entry) => entry.displayName,
		);
		expect(names).toEqual(["Another device", "Sahil's laptop"]);
		expect(await repo.listByOrganization(ORG_B)).toHaveLength(1);
	});
});

describe("Postgres connector device repository", () => {
	test("maps the row and validates the stored hash column", () => {
		const mapped = mapConnectorDeviceRow(row);
		expect(mapped.tokenHash).toBe(HASH_A);
		expect(mapped.lastSeenAt).toBeNull();
		expect(() =>
			mapConnectorDeviceRow({ ...row, token_hash: "not-a-hash" }),
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
		const repo = new PostgresConnectorDeviceRepository(sql);
		await repo.create(createInput());
		expect(calls[0].query).toContain("connector_devices");
		expect(calls[0].query).toContain("token_hash");
		expect(calls[0].params).toEqual([
			ORG_A,
			null,
			"Sahil's laptop",
			HASH_A,
			"active",
			null,
		]);
	});

	test("verify is tenant- and status-scoped and compares in constant time", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				return [row];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorDeviceRepository(sql);
		expect(await repo.verifyByTokenHash(ORG_A, HASH_A)).not.toBeNull();
		expect(calls[0].query).toContain("organization_id = $1");
		expect(calls[0].query).toContain("token_hash = $2");
		expect(calls[0].query).toContain("status = 'active'");
		expect(calls[0].params).toEqual([ORG_A, HASH_A]);
	});

	test("a row with a different stored hash never verifies", async () => {
		const sql = {
			unsafe: async () => [{ ...row, token_hash: HASH_B }],
		} as unknown as PgSql;
		const repo = new PostgresConnectorDeviceRepository(sql);
		expect(await repo.verifyByTokenHash(ORG_A, HASH_A)).toBeNull();
	});

	test("touchSeen and revoke update only the caller's row", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				return [row];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorDeviceRepository(sql);
		const seenAt = new Date("2026-10-31T12:05:00.000Z");
		await repo.touchSeen(ORG_A, DEVICE_ID, seenAt);
		expect(calls[0].query).toContain("last_seen_at = $3::timestamptz");
		await repo.revoke(ORG_A, DEVICE_ID);
		expect(calls[1].query).toContain("status = 'revoked'");
		expect(calls[1].query).toContain("WHERE organization_id = $1 AND id = $2");
		expect(calls[1].params).toEqual([ORG_A, DEVICE_ID]);
	});
});

describe("device token expiry", () => {
	test("rejects an expired token", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		await repo.create(createInput({ expiresAt: new Date(Date.now() - 1_000) }));
		expect(await repo.verifyByTokenHash(ORG_A, HASH_A)).toBeNull();
	});

	test("accepts an unexpired token and returns the expiry", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		const expiresAt = new Date(Date.now() + 60_000);
		await repo.create(createInput({ expiresAt }));
		const summary = await repo.verifyByTokenHash(ORG_A, HASH_A);
		expect(summary?.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
	});

	test("a legacy token without expiry still verifies", async () => {
		const repo = new InMemoryConnectorDeviceRepository();
		await repo.create(createInput());
		expect(await repo.verifyByTokenHash(ORG_A, HASH_A)).not.toBeNull();
	});
});
