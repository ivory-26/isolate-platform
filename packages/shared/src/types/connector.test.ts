import { describe, expect, test } from "bun:test";
import {
	CONNECTOR_AUTH_KINDS,
	CONNECTOR_CREDENTIAL_STATUSES,
	type ConnectorCredentialSummary,
	connectorAuthKindSchema,
	connectorCredentialStatusSchema,
	connectorDisplayNameSchema,
	connectorIdSchema,
	connectorScopesSchema,
	emptyFreeTierProfile,
	freeTierProfileSchema,
	MAX_CONNECTOR_DISPLAY_NAME_CHARS,
	MAX_CONNECTOR_SCOPE_CHARS,
	MAX_CONNECTOR_SCOPES,
} from "./connector";
import { asOrganizationId } from "./ids";

const summary: ConnectorCredentialSummary = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: asOrganizationId("22222222-2222-4222-8222-222222222222"),
	connectorId: "sentry",
	displayName: "Team Sentry",
	authKind: "api_key",
	scopes: ["issues:read"],
	status: "active",
	freeTierProfile: emptyFreeTierProfile(),
	metadata: { enabledTools: ["sentry.issue_context"] },
	keyVersion: 1,
	lastValidatedAt: new Date("2026-10-31T12:00:00.000Z"),
	lastUsedAt: null,
	createdAt: new Date("2026-10-31T11:00:00.000Z"),
	updatedAt: new Date("2026-10-31T12:00:00.000Z"),
};

describe("connector contracts", () => {
	test("auth kinds and statuses are closed unions", () => {
		expect(CONNECTOR_AUTH_KINDS).toEqual([
			"api_key",
			"oauth_client_credentials",
			"oauth_authorization_code",
			"service_account_json",
			"bot_token",
			"self_host_url_token",
		]);
		expect(CONNECTOR_CREDENTIAL_STATUSES).toEqual([
			"pending_validation",
			"active",
			"invalid",
			"revoked",
		]);
		for (const kind of CONNECTOR_AUTH_KINDS) {
			expect(connectorAuthKindSchema.parse(kind)).toBe(kind);
		}
		for (const status of CONNECTOR_CREDENTIAL_STATUSES) {
			expect(connectorCredentialStatusSchema.parse(status)).toBe(status);
		}
		expect(connectorAuthKindSchema.safeParse("oauth").success).toBe(false);
		expect(connectorCredentialStatusSchema.safeParse("expired").success).toBe(
			false,
		);
	});

	test("connector ids are lowercase bounded tokens", () => {
		expect(connectorIdSchema.parse("sentry")).toBe("sentry");
		expect(connectorIdSchema.parse("self-host")).toBe("self-host");
		expect(connectorIdSchema.parse("a".repeat(32))).toBe("a".repeat(32));
		for (const invalid of [
			"",
			"Sentry",
			"1sentry",
			"-sentry",
			"sentry_1",
			"sentry.api",
			"a".repeat(33),
		]) {
			expect(connectorIdSchema.safeParse(invalid).success).toBe(false);
		}
	});

	test("display names are 1-100 characters and trimmed", () => {
		expect(connectorDisplayNameSchema.parse("  Team Sentry  ")).toBe(
			"Team Sentry",
		);
		expect(connectorDisplayNameSchema.parse("x")).toBe("x");
		expect(
			connectorDisplayNameSchema.parse(
				"n".repeat(MAX_CONNECTOR_DISPLAY_NAME_CHARS),
			),
		).toHaveLength(MAX_CONNECTOR_DISPLAY_NAME_CHARS);
		expect(connectorDisplayNameSchema.safeParse("").success).toBe(false);
		expect(connectorDisplayNameSchema.safeParse("   ").success).toBe(false);
		expect(
			connectorDisplayNameSchema.safeParse(
				"n".repeat(MAX_CONNECTOR_DISPLAY_NAME_CHARS + 1),
			).success,
		).toBe(false);
	});

	test("scopes are capped at 32 tokens of at most 64 characters", () => {
		const scopes = Array.from(
			{ length: MAX_CONNECTOR_SCOPES },
			(_, index) => `scope:${index}`,
		);
		expect(connectorScopesSchema.parse(scopes)).toHaveLength(
			MAX_CONNECTOR_SCOPES,
		);
		expect(connectorScopesSchema.safeParse([...scopes, "extra"]).success).toBe(
			false,
		);
		expect(
			connectorScopesSchema.safeParse(["s".repeat(MAX_CONNECTOR_SCOPE_CHARS)])
				.success,
		).toBe(true);
		expect(
			connectorScopesSchema.safeParse([
				"s".repeat(MAX_CONNECTOR_SCOPE_CHARS + 1),
			]).success,
		).toBe(false);
		expect(connectorScopesSchema.safeParse(["bad scope"]).success).toBe(false);
	});

	test("free-tier profiles are strict and null means unverified", () => {
		expect(freeTierProfileSchema.parse(emptyFreeTierProfile())).toEqual({
			requestsPerMinute: null,
			requestsPerDay: null,
			eventsPerMonth: null,
			retentionDays: null,
		});
		expect(
			freeTierProfileSchema.parse({
				requestsPerMinute: 10,
				requestsPerDay: 100,
				eventsPerMonth: 5000,
				retentionDays: 30,
			}),
		).toEqual({
			requestsPerMinute: 10,
			requestsPerDay: 100,
			eventsPerMonth: 5000,
			retentionDays: 30,
		});
		for (const invalid of [
			{ ...emptyFreeTierProfile(), requestsPerMinute: -1 },
			{ ...emptyFreeTierProfile(), requestsPerDay: 1.5 },
			{ ...emptyFreeTierProfile(), extra: 1 },
		]) {
			expect(freeTierProfileSchema.safeParse(invalid).success).toBe(false);
		}
	});

	test("a credential summary carries no secret or ciphertext field", () => {
		const withSecret: ConnectorCredentialSummary = {
			...summary,
			// @ts-expect-error summaries never carry a secret
			secret: "s",
		};
		const withCiphertext: ConnectorCredentialSummary = {
			...summary,
			// @ts-expect-error summaries never carry ciphertext
			encryptedPayload: new Uint8Array(1),
		};
		expect(Object.hasOwn(withSecret, "secret")).toBe(true);
		expect(Object.hasOwn(withCiphertext, "encryptedPayload")).toBe(true);
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("ciphertext");
		expect(serialized).not.toContain("wrappedDek");
	});
});
