import { describe, expect, test } from "bun:test";
import {
	AUTONOMY_LEVELS,
	autonomyLevelSchema,
	EVENT_DELIVERY_STATUSES,
	EVENT_VERIFICATION_METHODS,
	eventDeliveryStatusSchema,
	eventVerificationSchema,
	GITHUB_INSTALLATION_STATUSES,
	githubInstallationSummarySchema,
	INTEGRATION_CONNECTOR_IDS,
	integrationSubscriptionInputSchema,
	MAX_INTEGRATION_CONFIG_BYTES,
	MAX_INTEGRATION_ENVIRONMENTS,
	MAX_INTEGRATION_EVENT_KINDS,
} from "./integrations";

function subscription(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		connectorId: "sentry",
		displayName: "Production Sentry",
		eventKinds: ["issue.created", "issue.regressed"],
		environmentAllowlist: ["production"],
		minSeverity: "high",
		repositoryId: "11111111-1111-4111-8111-111111111111",
		baseBranch: "main",
		autonomyLevel: "A2",
		enabled: true,
		config: { project: "checkout", region: "eu" },
		...overrides,
	};
}

function installation(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		organizationId: "11111111-1111-4111-8111-111111111111",
		installationId: "98765432",
		accountLogin: "acme",
		accountType: "Organization",
		repositorySelection: "selected",
		status: "active",
		createdBy: "33333333-3333-4333-8333-333333333333",
		createdAt: "2026-11-02T10:00:00.000Z",
		updatedAt: "2026-11-02T10:00:00.000Z",
		...overrides,
	};
}

describe("integration connector union and autonomy", () => {
	test("the ten connectors are the closed union", () => {
		expect(INTEGRATION_CONNECTOR_IDS).toHaveLength(10);
		expect(INTEGRATION_CONNECTOR_IDS).toContain("github");
		expect(INTEGRATION_CONNECTOR_IDS).toContain("signoz");
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ connectorId: "slack" }),
			).success,
		).toBe(false);
	});

	test("autonomy is limited to A0-A3", () => {
		expect(AUTONOMY_LEVELS).toEqual(["A0", "A1", "A2", "A3"]);
		for (const level of AUTONOMY_LEVELS) {
			expect(autonomyLevelSchema.parse(level)).toBe(level);
		}
		expect(autonomyLevelSchema.safeParse("A4").success).toBe(false);
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ autonomyLevel: "A4" }),
			).success,
		).toBe(false);
	});
});

describe("integration subscription input", () => {
	test("applies bounded defaults", () => {
		const parsed = integrationSubscriptionInputSchema.parse({
			connectorId: "github",
			displayName: "Failed workflows",
		});
		expect(parsed).toEqual({
			connectorId: "github",
			displayName: "Failed workflows",
			eventKinds: [],
			environmentAllowlist: ["production"],
			minSeverity: "high",
			repositoryId: null,
			baseBranch: null,
			autonomyLevel: "A2",
			enabled: true,
			config: {},
		});
	});

	test("accepts the full bounded shape and nullable repository fields", () => {
		const parsed = integrationSubscriptionInputSchema.parse(subscription());
		expect(parsed.connectorId).toBe("sentry");
		expect(parsed.eventKinds).toEqual(["issue.created", "issue.regressed"]);
		expect(parsed.repositoryId).toBe("11111111-1111-4111-8111-111111111111");
		const unbound = integrationSubscriptionInputSchema.parse(
			subscription({ repositoryId: null, baseBranch: null }),
		);
		expect(unbound.repositoryId).toBeNull();
		expect(unbound.baseBranch).toBeNull();
	});

	test("rejects unknown fields at both levels", () => {
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ unknownField: true }),
			).success,
		).toBe(false);
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ config: { nested: { extra: 1 }, unused: 0 } }),
			).success,
		).toBe(true);
	});

	test("bounds the number of event kinds and environments", () => {
		const tooManyKinds = Array.from(
			{ length: MAX_INTEGRATION_EVENT_KINDS + 1 },
			(_, index) => `event.${index}`,
		);
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ eventKinds: tooManyKinds }),
			).success,
		).toBe(false);
		const tooManyEnvironments = Array.from(
			{ length: MAX_INTEGRATION_ENVIRONMENTS + 1 },
			(_, index) => `env-${index}`,
		);
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ environmentAllowlist: tooManyEnvironments }),
			).success,
		).toBe(false);
	});

	test("rejects duplicate entries and malformed tokens", () => {
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ eventKinds: ["issue.created", "issue.created"] }),
			).success,
		).toBe(false);
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ environmentAllowlist: ["production", "production"] }),
			).success,
		).toBe(false);
		for (const connectorId of ["Sentry", "sentry ", ""]) {
			expect(
				integrationSubscriptionInputSchema.safeParse(
					subscription({ connectorId }),
				).success,
			).toBe(false);
		}
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ eventKinds: ["Not-A-Kind"] }),
			).success,
		).toBe(false);
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ baseBranch: "-bad" }),
			).success,
		).toBe(false);
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ repositoryId: "not-a-uuid" }),
			).success,
		).toBe(false);
	});

	test("rejects unbounded or non-JSON config values", () => {
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({
					config: { blob: "x".repeat(MAX_INTEGRATION_CONFIG_BYTES) },
				}),
			).success,
		).toBe(false);
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ config: { nested: { a: { b: { c: 1 } } } } }),
			).success,
		).toBe(false);
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ config: { when: () => undefined } }),
			).success,
		).toBe(false);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(
			integrationSubscriptionInputSchema.safeParse(
				subscription({ config: cyclic }),
			).success,
		).toBe(false);
	});
});

describe("event delivery enums", () => {
	test("status and verification are closed unions", () => {
		for (const status of EVENT_DELIVERY_STATUSES) {
			expect(eventDeliveryStatusSchema.parse(status)).toBe(status);
		}
		for (const method of EVENT_VERIFICATION_METHODS) {
			expect(eventVerificationSchema.parse(method)).toBe(method);
		}
		expect(eventDeliveryStatusSchema.safeParse("delivered").success).toBe(
			false,
		);
		expect(eventVerificationSchema.safeParse("body_hash").success).toBe(false);
	});
});

describe("GitHub installation summary", () => {
	test("accepts a bounded summary", () => {
		const parsed = githubInstallationSummarySchema.parse(installation());
		expect(parsed.installationId).toBe("98765432");
		expect(parsed.accountType).toBe("Organization");
	});

	test("rejects unknown fields, non-numeric ids and bad enums", () => {
		expect(
			githubInstallationSummarySchema.safeParse(
				installation({ token: "ghs_secret" }),
			).success,
		).toBe(false);
		for (const installationId of ["", "0", "12ab", "1".repeat(21)]) {
			expect(
				githubInstallationSummarySchema.safeParse(
					installation({ installationId }),
				).success,
			).toBe(false);
		}
		expect(
			githubInstallationSummarySchema.safeParse(
				installation({ status: "pending" }),
			).success,
		).toBe(false);
		expect(
			githubInstallationSummarySchema.safeParse(
				installation({ accountType: "Bot" }),
			).success,
		).toBe(false);
		expect(
			githubInstallationSummarySchema.safeParse(
				installation({ accountLogin: "" }),
			).success,
		).toBe(false);
		expect(GITHUB_INSTALLATION_STATUSES).toEqual([
			"active",
			"suspended",
			"revoked",
		]);
	});
});
