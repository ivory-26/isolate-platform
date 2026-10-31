import { describe, expect, test } from "bun:test";
import { asOrganizationId, PlatformError } from "@isolate/shared";
import type { PgSql } from "../client";
import { InMemoryConnectorCredentialRepository } from "../testing/connector-credentials-fake";
import {
	type ConnectorCredentialCiphertext,
	type CreateConnectorCredentialInput,
	mapConnectorCredentialRow,
	normalizeFreeTierProfileValue,
	PostgresConnectorCredentialRepository,
} from "./connector-credentials";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");

function ciphertext(overrides: Partial<ConnectorCredentialCiphertext> = {}) {
	return {
		encryptedPayload: new Uint8Array([1, 2, 3, 4]),
		wrappedDek: new Uint8Array([5, 6, 7, 8]),
		keyVersion: 1,
		...overrides,
	};
}

function createInput(
	overrides: Partial<CreateConnectorCredentialInput> = {},
): CreateConnectorCredentialInput {
	return {
		organizationId: ORG_A,
		connectorId: "sentry",
		displayName: "Team Sentry",
		authKind: "api_key",
		ciphertext: ciphertext(),
		scopes: ["issues:read"],
		status: "pending_validation",
		freeTierProfile: {
			requestsPerMinute: null,
			requestsPerDay: null,
			eventsPerMonth: 5000,
			retentionDays: 30,
		},
		metadata: { enabledTools: ["sentry.issue_context"] },
		createdBy: "44444444-4444-4444-8444-444444444444",
		...overrides,
	};
}

describe("in-memory connector credential repository", () => {
	test("create returns a summary without ciphertext", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		const summary = await repo.create(createInput());
		expect(summary.connectorId).toBe("sentry");
		expect(summary.displayName).toBe("Team Sentry");
		expect(summary.status).toBe("pending_validation");
		expect(summary.scopes).toEqual(["issues:read"]);
		expect(summary.freeTierProfile.eventsPerMonth).toBe(5000);
		expect(Object.keys(summary)).not.toContain("encryptedPayload");
		expect(Object.keys(summary)).not.toContain("wrappedDek");
		expect(JSON.stringify(summary)).not.toContain("encryptedPayload");
	});

	test("reads are tenant-scoped", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		const created = await repo.create(createInput());
		expect(await repo.listByOrganization(ORG_A)).toHaveLength(1);
		expect(await repo.listByOrganization(ORG_B)).toHaveLength(0);
		expect(await repo.get(ORG_B, created.id)).toBeNull();
		expect(await repo.getSecret(ORG_B, created.id)).toBeNull();
		expect(await repo.getSecret(ORG_A, created.id)).not.toBeNull();
	});

	test("getSecret returns defensive byte copies and never list summaries", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		const created = await repo.create(createInput());
		const secret = await repo.getSecret(ORG_A, created.id);
		expect(secret?.encryptedPayload).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(secret?.wrappedDek).toEqual(new Uint8Array([5, 6, 7, 8]));
		secret?.encryptedPayload.set([9]);
		const again = await repo.getSecret(ORG_A, created.id);
		expect(again?.encryptedPayload).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	test("revoke zeroes the ciphertext, keeps the row and hides the secret", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		const created = await repo.create(createInput());
		expect(await repo.revoke(ORG_B, created.id)).toBeNull();
		const revoked = await repo.revoke(ORG_A, created.id);
		expect(revoked?.status).toBe("revoked");
		expect(await repo.getSecret(ORG_A, created.id)).toBeNull();
		expect(repo.ciphertextOf(created.id)?.encryptedPayload).toHaveLength(0);
		expect(repo.ciphertextOf(created.id)?.wrappedDek).toHaveLength(0);
		expect(await repo.listByOrganization(ORG_A)).toHaveLength(1);
	});

	test("setStatus and touch timestamps update only the caller's row", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		const created = await repo.create(createInput());
		expect(await repo.setStatus(ORG_B, created.id, "active")).toBeNull();
		const active = await repo.setStatus(ORG_A, created.id, "active");
		expect(active?.status).toBe("active");
		const validatedAt = new Date("2026-10-31T12:00:00.000Z");
		const usedAt = new Date("2026-10-31T12:05:00.000Z");
		expect(
			(await repo.touchValidated(ORG_A, created.id, validatedAt))
				?.lastValidatedAt,
		).toEqual(validatedAt);
		expect(
			(await repo.touchUsed(ORG_A, created.id, usedAt))?.lastUsedAt,
		).toEqual(usedAt);
	});

	test("delete is tenant-scoped and idempotent", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		const created = await repo.create(createInput());
		expect(await repo.delete(ORG_B, created.id)).toBe(false);
		expect(await repo.delete(ORG_A, created.id)).toBe(true);
		expect(await repo.delete(ORG_A, created.id)).toBe(false);
		expect(repo.rowCount).toBe(0);
	});

	test("rejects duplicates and invalid bounds without echoing input", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		await repo.create(createInput());
		await expect(repo.create(createInput())).rejects.toBeInstanceOf(
			PlatformError,
		);
		for (const invalid of [
			createInput({ connectorId: "Sentry" }),
			createInput({ displayName: "" }),
			createInput({ authKind: "oauth" as never }),
			createInput({ status: "expired" as never }),
			createInput({ scopes: Array.from({ length: 33 }, (_, i) => `s${i}`) }),
			createInput({
				ciphertext: ciphertext({ encryptedPayload: new Uint8Array(0) }),
			}),
			createInput({ ciphertext: ciphertext({ keyVersion: 0 }) }),
		]) {
			await expect(repo.create(invalid)).rejects.toBeInstanceOf(PlatformError);
		}
	});

	test("free-tier profile mapping ignores catalog-only fields", () => {
		expect(
			normalizeFreeTierProfileValue({
				availability: "free_forever",
				requestsPerMinute: 10,
				requestsPerDay: "not-a-number",
				eventsPerMonth: 5,
				retentionDays: null,
			}),
		).toEqual({
			requestsPerMinute: 10,
			requestsPerDay: null,
			eventsPerMonth: 5,
			retentionDays: null,
		});
		expect(normalizeFreeTierProfileValue(null)).toEqual({
			requestsPerMinute: null,
			requestsPerDay: null,
			eventsPerMonth: null,
			retentionDays: null,
		});
	});
});

describe("Postgres connector credential mapping", () => {
	const row: Record<string, unknown> = {
		id: "33333333-3333-4333-8333-333333333333",
		organization_id: ORG_A,
		connector_id: "sentry",
		display_name: "Team Sentry",
		auth_kind: "api_key",
		scopes: ["issues:read"],
		status: "active",
		free_tier_profile: JSON.stringify({ eventsPerMonth: 5000 }),
		metadata: JSON.stringify({ enabledTools: [] }),
		key_version: 1,
		last_validated_at: new Date("2026-10-31T12:00:00.000Z"),
		last_used_at: null,
		created_by: null,
		created_at: new Date("2026-10-31T11:00:00.000Z"),
		updated_at: new Date("2026-10-31T12:00:00.000Z"),
	};

	test("decodes jsonb strings from the pooled driver", () => {
		const mapped = mapConnectorCredentialRow(row);
		expect(mapped.freeTierProfile.eventsPerMonth).toBe(5000);
		expect(mapped.metadata).toEqual({ enabledTools: [] });
		expect(mapped.lastValidatedAt).toEqual(
			new Date("2026-10-31T12:00:00.000Z"),
		);
	});

	test("getSecret uses the tenant-scoped ciphertext select and maps bytea", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				return [
					{
						...row,
						encrypted_payload: new Uint8Array([1, 2, 3]),
						wrapped_dek: new Uint8Array([4, 5]),
					},
				];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorCredentialRepository(sql);
		const secret = await repo.getSecret(
			ORG_A,
			"33333333-3333-4333-8333-333333333333",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].query).toContain("WHERE organization_id = $1");
		expect(calls[0].query).toContain("status <> 'revoked'");
		expect(calls[0].params).toEqual([
			ORG_A,
			"33333333-3333-4333-8333-333333333333",
		]);
		expect(secret?.encryptedPayload).toEqual(new Uint8Array([1, 2, 3]));
		expect(secret?.wrappedDek).toEqual(new Uint8Array([4, 5]));
	});
});
