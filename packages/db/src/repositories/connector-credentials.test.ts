import { describe, expect, test } from "bun:test";
import { asOrganizationId, PlatformError } from "@isolate/shared";
import type { PgSql } from "../client";
import { InMemoryConnectorCredentialRepository } from "../testing/connector-credentials-fake";
import {
	type CreateConnectorCredentialInput,
	mapConnectorCredentialRow,
	normalizeFreeTierProfileValue,
	PostgresConnectorCredentialRepository,
} from "./connector-credentials";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";

function createInput(
	overrides: Partial<CreateConnectorCredentialInput> = {},
): CreateConnectorCredentialInput {
	return {
		organizationId: ORG_A,
		deviceId: DEVICE_ID,
		connectorId: "sentry",
		displayName: "Team Sentry",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/team",
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

const row: Record<string, unknown> = {
	id: "55555555-5555-4555-8555-555555555555",
	organization_id: ORG_A,
	device_id: DEVICE_ID,
	connector_id: "sentry",
	display_name: "Team Sentry",
	auth_kind: "api_key",
	credential_ref: "keychain:isolate/sentry/team",
	scopes: ["issues:read"],
	status: "active",
	free_tier_profile: JSON.stringify({ eventsPerMonth: 5000 }),
	metadata: JSON.stringify({ enabledTools: [] }),
	last_validated_at: new Date("2026-10-31T12:00:00.000Z"),
	last_used_at: null,
};

describe("in-memory connector credential repository", () => {
	test("create returns metadata only, never a secret or ciphertext", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		const summary = await repo.create(createInput());
		expect(summary.deviceId).toBe(DEVICE_ID);
		expect(summary.connectorId).toBe("sentry");
		expect(summary.displayName).toBe("Team Sentry");
		expect(summary.credentialRef).toBe("keychain:isolate/sentry/team");
		expect(summary.status).toBe("pending_validation");
		expect(summary.scopes).toEqual(["issues:read"]);
		expect(summary.freeTierProfile.eventsPerMonth).toBe(5000);
		for (const forbidden of [
			"secret",
			"encryptedPayload",
			"wrappedDek",
			"keyVersion",
			"ciphertext",
		]) {
			expect(Object.keys(summary)).not.toContain(forbidden);
		}
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("encrypted");
		expect(serialized).not.toContain("wrapped");
		expect(serialized).not.toContain("keyVersion");
		expect("getSecret" in repo).toBe(false);
	});

	test("reads are tenant-scoped", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		const created = await repo.create(createInput());
		expect(await repo.listByOrganization(ORG_A)).toHaveLength(1);
		expect(await repo.listByOrganization(ORG_B)).toHaveLength(0);
		expect(await repo.get(ORG_B, created.id)).toBeNull();
		expect(await repo.get(ORG_A, created.id)).not.toBeNull();
	});

	test("revoke flips status, keeps the row and the ref", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		const created = await repo.create(createInput());
		expect(await repo.revoke(ORG_B, created.id)).toBeNull();
		const revoked = await repo.revoke(ORG_A, created.id);
		expect(revoked?.status).toBe("revoked");
		expect(revoked?.credentialRef).toBe("keychain:isolate/sentry/team");
		expect(await repo.listByOrganization(ORG_A)).toHaveLength(1);
		expect(repo.rowCount).toBe(1);
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

	test("enforces both migration unique constraints", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		await repo.create(createInput());
		await expect(repo.create(createInput())).rejects.toBeInstanceOf(
			PlatformError,
		);
		await expect(
			repo.create(createInput({ displayName: "Other name" })),
		).rejects.toBeInstanceOf(PlatformError);
		const otherConnector = await repo.create(
			createInput({
				connectorId: "pagerduty",
				displayName: "Team Sentry",
			}),
		);
		expect(otherConnector.connectorId).toBe("pagerduty");
		const otherDevice = await repo.create(
			createInput({
				deviceId: "66666666-6666-4666-8666-666666666666",
				displayName: "Second device",
			}),
		);
		expect(otherDevice.deviceId).toBe("66666666-6666-4666-8666-666666666666");
	});

	test("rejects invalid bounds without echoing input", async () => {
		const repo = new InMemoryConnectorCredentialRepository();
		for (const invalid of [
			createInput({ connectorId: "Sentry" }),
			createInput({ displayName: "" }),
			createInput({ authKind: "oauth" as never }),
			createInput({ status: "expired" as never }),
			createInput({ scopes: Array.from({ length: 33 }, (_, i) => `s${i}`) }),
			createInput({ credentialRef: "" }),
			createInput({ credentialRef: "   " }),
			createInput({ credentialRef: "r".repeat(201) }),
			createInput({ deviceId: "" }),
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
	test("decodes jsonb strings and the device-held columns", () => {
		const mapped = mapConnectorCredentialRow(row);
		expect(mapped.deviceId).toBe(DEVICE_ID);
		expect(mapped.credentialRef).toBe("keychain:isolate/sentry/team");
		expect(mapped.freeTierProfile.eventsPerMonth).toBe(5000);
		expect(mapped.metadata).toEqual({ enabledTools: [] });
		expect(mapped.lastValidatedAt).toEqual(
			new Date("2026-10-31T12:00:00.000Z"),
		);
		expect(mapped.lastUsedAt).toBeNull();
	});

	test("create writes device_id and credential_ref, never ciphertext", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				return [row];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorCredentialRepository(sql);
		const created = await repo.create(createInput());
		expect(created.credentialRef).toBe("keychain:isolate/sentry/team");
		expect(calls).toHaveLength(1);
		for (const column of ["device_id", "credential_ref", "connector_id"]) {
			expect(calls[0].query).toContain(column);
		}
		for (const forbidden of [
			"encrypted_payload",
			"wrapped_dek",
			"key_version",
			"secret",
		]) {
			expect(calls[0].query).not.toContain(forbidden);
		}
		expect(calls[0].params).toEqual([
			ORG_A,
			DEVICE_ID,
			"sentry",
			"Team Sentry",
			"api_key",
			"keychain:isolate/sentry/team",
			["issues:read"],
			"pending_validation",
			JSON.stringify(createInput().freeTierProfile),
			JSON.stringify(createInput().metadata),
			"44444444-4444-4444-8444-444444444444",
		]);
	});

	test("reads and revoke stay tenant-scoped and never touch ciphertext", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				return [row];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorCredentialRepository(sql);
		const credentialId = String(row.id);
		await repo.revoke(ORG_A, credentialId);
		expect(calls[0].query).toContain("WHERE organization_id = $1 AND id = $2");
		expect(calls[0].query).toContain("status = 'revoked'");
		expect(calls[0].query).not.toContain("encrypted_payload");
		expect(calls[0].query).not.toContain("wrapped_dek");
		expect(calls[0].params).toEqual([ORG_A, credentialId]);
	});
});
