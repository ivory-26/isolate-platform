import { describe, expect, test } from "bun:test";
import { platformCapabilityFor } from "./capabilities";
import {
	eventDeliverySchema,
	integrationSubscriptionSchema,
	MAX_DELIVERIES_PER_READ,
	MAX_EVENT_KINDS,
	parseEnvironmentList,
	parseIntegrationsSearch,
	prepareSubscriptionWrite,
	saveSubscriptionSchema,
} from "./contracts";

const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

const baseRule = {
	connectorId: "sentry",
	displayName: "Production critical/high",
	repositoryId: REPOSITORY_ID,
} as const;

const subscriptionRow = {
	id: CONNECTION_ID,
	connectorId: "sentry",
	displayName: "Production",
	eventKinds: ["issue_created"],
	environmentAllowlist: ["production"],
	minSeverity: "high",
	repositoryId: REPOSITORY_ID,
	repositoryName: "acme/widgets",
	baseBranch: "main",
	autonomyLevel: "A1",
	enabled: true,
	createdAt: "2026-11-02T10:00:00.000Z",
	updatedAt: "2026-11-02T10:00:00.000Z",
};

describe("parseIntegrationsSearch", () => {
	test("defaults to the catalog and accepts the known tabs", () => {
		expect(parseIntegrationsSearch({})).toEqual({ tab: "catalog" });
		expect(parseIntegrationsSearch({ tab: "relays" })).toEqual({
			tab: "relays",
		});
		expect(parseIntegrationsSearch({ tab: "connected" })).toEqual({
			tab: "connected",
		});
	});

	test("ignores an unknown tab", () => {
		expect(parseIntegrationsSearch({ tab: "settings" })).toEqual({
			tab: "catalog",
		});
	});
});

describe("saveSubscriptionSchema", () => {
	test("applies the safe defaults for an observe-only rule", () => {
		const parsed = saveSubscriptionSchema.parse({
			connectorId: "sentry",
			displayName: "  Observe only  ",
			autonomyLevel: "A0",
		});
		expect(parsed.displayName).toBe("Observe only");
		expect(parsed.eventKinds).toEqual([]);
		expect(parsed.environmentAllowlist).toEqual(["production"]);
		expect(parsed.minSeverity).toBe("high");
		expect(parsed.repositoryId).toBeNull();
		expect(parsed.baseBranch).toBeNull();
		expect(parsed.enabled).toBe(true);
	});

	test("accepts a bounded A2 rule", () => {
		const parsed = saveSubscriptionSchema.safeParse({
			...baseRule,
			eventKinds: ["issue_created", "issue_unresolved"],
			environmentAllowlist: ["production", "staging"],
			minSeverity: "critical",
		});
		expect(parsed.success).toBe(true);
	});

	test("refuses an event kind the connector does not emit", () => {
		const parsed = saveSubscriptionSchema.safeParse({
			...baseRule,
			eventKinds: ["alert_firing"],
		});
		expect(parsed.success).toBe(false);
	});

	test("refuses the unsupported A1 level", () => {
		expect(
			saveSubscriptionSchema.safeParse({ ...baseRule, autonomyLevel: "A1" })
				.success,
		).toBe(false);
	});

	test("requires a repository for A2 and A3", () => {
		for (const autonomyLevel of ["A2", "A3"] as const) {
			expect(
				saveSubscriptionSchema.safeParse({
					connectorId: "sentry",
					displayName: "Needs repo",
					autonomyLevel,
					repositoryId: null,
				}).success,
			).toBe(false);
		}
		expect(
			saveSubscriptionSchema.safeParse({
				connectorId: "sentry",
				displayName: "Observe",
				autonomyLevel: "A0",
				repositoryId: null,
			}).success,
		).toBe(true);
	});

	test("bounds the event-kind and environment lists", () => {
		expect(
			saveSubscriptionSchema.safeParse({
				...baseRule,
				eventKinds: Array.from(
					{ length: MAX_EVENT_KINDS + 1 },
					() => "issue_created",
				),
			}).success,
		).toBe(false);
		expect(
			saveSubscriptionSchema.safeParse({
				...baseRule,
				environmentAllowlist: Array.from(
					{ length: 17 },
					(_, index) => `env-${index}`,
				),
			}).success,
		).toBe(false);
	});

	test("refuses a branch with shell metacharacters", () => {
		expect(
			saveSubscriptionSchema.safeParse({ ...baseRule, baseBranch: "main;rm" })
				.success,
		).toBe(false);
	});
});

describe("prepareSubscriptionWrite", () => {
	test("de-duplicates lists and sends scalar columns only", () => {
		const parsed = saveSubscriptionSchema.parse({
			...baseRule,
			eventKinds: ["issue_created", "issue_created", "issue_unresolved"],
			environmentAllowlist: ["production", "production"],
		});
		expect(prepareSubscriptionWrite(parsed)).toEqual({
			connectorId: "sentry",
			displayName: "Production critical/high",
			eventKinds: ["issue_created", "issue_unresolved"],
			environmentAllowlist: ["production"],
			minSeverity: "high",
			repositoryId: REPOSITORY_ID,
			baseBranch: null,
			autonomyLevel: "A2",
			enabled: true,
		});
	});
});

describe("parseEnvironmentList", () => {
	test("splits, trims and de-duplicates", () => {
		expect(parseEnvironmentList(" production, staging  production ")).toEqual({
			ok: true,
			values: ["production", "staging"],
		});
		expect(parseEnvironmentList("")).toEqual({ ok: true, values: [] });
	});

	test("refuses invalid names and more than sixteen entries", () => {
		expect(parseEnvironmentList("prod@ction").ok).toBe(false);
		const tooMany = Array.from(
			{ length: 17 },
			(_, index) => `env-${index}`,
		).join(",");
		expect(parseEnvironmentList(tooMany).ok).toBe(false);
	});
});

describe("stored subscription contract", () => {
	test("accepts a stored A1 row and bounded fields", () => {
		expect(
			integrationSubscriptionSchema.safeParse(subscriptionRow).success,
		).toBe(true);
	});

	test("rejects an unknown connector or oversized environment list", () => {
		expect(
			integrationSubscriptionSchema.safeParse({
				...subscriptionRow,
				connectorId: "jenkins",
			}).success,
		).toBe(false);
		expect(
			integrationSubscriptionSchema.safeParse({
				...subscriptionRow,
				environmentAllowlist: Array.from(
					{ length: 17 },
					(_, index) => `env-${index}`,
				),
			}).success,
		).toBe(false);
	});
});

describe("event delivery contract", () => {
	const delivery = {
		id: CONNECTION_ID,
		connectorId: "sentry",
		source: "sentry",
		eventKind: "issue_created",
		severity: "high",
		title: "TypeError in checkout",
		summary: "Bounded summary",
		status: "task_created",
		reasonCode: null,
		repositoryName: "acme/widgets",
		taskId: REPOSITORY_ID,
		receivedAt: "2026-11-02T10:00:00.000Z",
		links: [{ label: "Sentry issue", url: "https://sentry.io/issues/1" }],
	};

	test("accepts a bounded delivery and rejects oversized or unknown values", () => {
		expect(eventDeliverySchema.safeParse(delivery).success).toBe(true);
		expect(
			eventDeliverySchema.safeParse({
				...delivery,
				summary: "x".repeat(2_001),
			}).success,
		).toBe(false);
		expect(
			eventDeliverySchema.safeParse({ ...delivery, status: "mystery" }).success,
		).toBe(false);
		expect(
			eventDeliverySchema.safeParse({
				...delivery,
				links: Array.from({ length: 6 }, () => delivery.links[0]),
			}).success,
		).toBe(false);
	});
});

describe("connector capability seam", () => {
	test("maps the documented connector tokens onto the implemented role set", () => {
		expect(platformCapabilityFor("connector:read")).toBe("task:read");
		expect(platformCapabilityFor("connector:manage")).toBe("member:manage");
	});

	test("keeps delivery reads bounded", () => {
		expect(MAX_DELIVERIES_PER_READ).toBe(100);
	});
});
