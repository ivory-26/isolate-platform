import { describe, expect, test } from "bun:test";
import { integrationCatalogEntry } from "./catalog";
import { MAX_DELIVERY_SUMMARY_CHARS } from "./contracts";
import {
	INTEGRATION_CONNECTION_SQL,
	INTEGRATION_DELIVERIES_SQL,
	INTEGRATION_LAST_EVENT_SQL,
	INTEGRATION_SUBSCRIPTIONS_SQL,
	INTEGRATION_TRIGGER_COUNT_SQL,
	INTEGRATION_USAGE_SQL,
	mapConnectionRow,
	parseSignalLinks,
	readDeliveries,
	readIntegrations,
	readSubscriptions,
	safeText,
	summarizeIntegration,
} from "./integrations-read.server";

const ORG = "11111111-1111-4111-8111-111111111111";

type SqlHandler = (query: string, parameters: readonly unknown[]) => unknown;

function fakeSql(handler: SqlHandler) {
	const calls: { query: string; parameters: readonly unknown[] }[] = [];
	return {
		calls,
		sql: {
			async unsafe(query: string, parameters?: readonly unknown[]) {
				const bound = parameters ?? [];
				calls.push({ query, parameters: bound });
				return handler(query, bound);
			},
		},
	};
}

function connectionRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		connector_id: "sentry",
		display_name: "Team Sentry",
		auth_kind: "api_key",
		status: "active",
		scopes: ["event:read", "project:read"],
		metadata: { enabled_tools: ["sentry.list_issues", "sentry.get_issue"] },
		last_validated_at: new Date("2026-11-02T09:00:00.000Z"),
		last_used_at: null,
		relay_id: "33333333-3333-4333-8333-333333333333",
		relay_name: "sre-laptop",
		relay_status: "active",
		...overrides,
	};
}

function triggerRow(overrides: Record<string, unknown> = {}) {
	return {
		connector_id: "sentry",
		trigger_count: "3",
		enabled_trigger_count: "2",
		...overrides,
	};
}

function eventRow(overrides: Record<string, unknown> = {}) {
	return {
		connector_id: "sentry",
		last_event_at: new Date("2026-11-02T10:00:00.000Z"),
		...overrides,
	};
}

function usageRow(overrides: Record<string, unknown> = {}) {
	return {
		connector_id: "sentry",
		period: "2026-11-02",
		request_count: "7",
		...overrides,
	};
}

function dispatch(tables: {
	connections?: Record<string, unknown>[];
	triggers?: Record<string, unknown>[];
	events?: Record<string, unknown>[];
	usage?: Record<string, unknown>[];
	subscriptions?: Record<string, unknown>[];
	deliveries?: Record<string, unknown>[];
}): SqlHandler {
	return (query) => {
		if (query.includes("FROM connector_credentials cc")) {
			return tables.connections ?? [];
		}
		if (
			query.includes("GROUP BY connector_id") &&
			query.includes("trigger_count")
		) {
			return tables.triggers ?? [];
		}
		if (query.includes("max(received_at)")) return tables.events ?? [];
		if (query.includes("DISTINCT ON (connector_id)")) return tables.usage ?? [];
		if (query.includes("FROM integration_subscriptions s")) {
			return tables.subscriptions ?? [];
		}
		if (query.includes("FROM event_deliveries d")) {
			return tables.deliveries ?? [];
		}
		throw new Error(`unexpected query: ${query.slice(0, 40)}`);
	};
}

describe("readIntegrations", () => {
	test("binds the organization in every statement", async () => {
		const { sql, calls } = fakeSql(dispatch({}));
		await readIntegrations(sql, ORG);
		expect(calls).toHaveLength(4);
		for (const call of calls) {
			expect(call.parameters[0]).toBe(ORG);
		}
	});

	test("maps connections, trigger counts, last events and usage", async () => {
		const { sql } = fakeSql(
			dispatch({
				connections: [
					connectionRow(),
					connectionRow({
						id: "44444444-4444-4444-8444-444444444444",
						display_name: "Older duplicate",
						status: "pending_validation",
					}),
					connectionRow({
						connector_id: "grafana",
						status: "revoked",
					}),
					connectionRow({ connector_id: "not-a-connector" }),
				],
				triggers: [triggerRow()],
				events: [eventRow()],
				usage: [usageRow()],
			}),
		);
		const aggregate = await readIntegrations(sql, ORG);
		expect(aggregate.connections.get("sentry")?.displayName).toBe(
			"Team Sentry",
		);
		expect(aggregate.connections.get("sentry")?.enabledTools).toEqual([
			"sentry.list_issues",
			"sentry.get_issue",
		]);
		expect(aggregate.connections.has("grafana")).toBe(false);
		expect(aggregate.connections.has("not-a-connector")).toBe(false);
		expect(aggregate.triggerCounts.get("sentry")).toBe(3);
		expect(aggregate.enabledTriggerCounts.get("sentry")).toBe(2);
		expect(aggregate.lastEventAt.get("sentry")).toBe(
			"2026-11-02T10:00:00.000Z",
		);
		expect(aggregate.usage.get("sentry")).toEqual({
			requestsThisPeriod: 7,
			period: "2026-11-02T00:00:00.000Z",
		});

		const entry = integrationCatalogEntry("sentry");
		if (entry === undefined) throw new Error("catalog missing sentry");
		const summary = summarizeIntegration(entry, aggregate);
		expect(summary.triggerCount).toBe(3);
		expect(summary.enabledTriggerCount).toBe(2);
		expect(summary.connection?.relayName).toBe("sre-laptop");
	});
});

describe("readSubscriptions", () => {
	test("maps a joined repository and preserves stored A1", async () => {
		const { sql, calls } = fakeSql(
			dispatch({
				subscriptions: [
					{
						id: "55555555-5555-4555-8555-555555555555",
						connector_id: "sentry",
						display_name: "Production",
						event_kinds: ["issue_created"],
						environment_allowlist: ["production"],
						min_severity: "critical",
						repository_id: "66666666-6666-4666-8666-666666666666",
						base_branch: "main",
						autonomy_level: "A1",
						enabled: "t",
						created_at: new Date("2026-11-01T10:00:00.000Z"),
						updated_at: new Date("2026-11-01T10:00:00.000Z"),
						repository_name: "acme/widgets",
					},
				],
			}),
		);
		const result = await readSubscriptions(sql, ORG, "sentry");
		expect(calls[0]?.parameters).toEqual([ORG, "sentry", 51]);
		expect(result.truncated).toBe(false);
		expect(result.subscriptions[0]).toMatchObject({
			connectorId: "sentry",
			displayName: "Production",
			minSeverity: "critical",
			autonomyLevel: "A1",
			enabled: true,
			repositoryName: "acme/widgets",
			baseBranch: "main",
		});
	});

	test("caps at 50 rows and marks truncation", async () => {
		const rows = Array.from({ length: 51 }, (_, index) => ({
			id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			connector_id: "sentry",
			display_name: `Rule ${index}`,
			event_kinds: [],
			environment_allowlist: ["production"],
			min_severity: "high",
			repository_id: null,
			base_branch: null,
			autonomy_level: "A0",
			enabled: true,
			created_at: new Date("2026-11-01T10:00:00.000Z"),
			updated_at: new Date("2026-11-01T10:00:00.000Z"),
			repository_name: null,
		}));
		const { sql } = fakeSql(dispatch({ subscriptions: rows }));
		const result = await readSubscriptions(sql, ORG);
		expect(result.subscriptions).toHaveLength(50);
		expect(result.truncated).toBe(true);
	});
});

describe("readDeliveries", () => {
	const deliveryRow = {
		id: "77777777-7777-4777-8777-777777777777",
		connector_id: "sentry",
		source: "sentry",
		event_kind: "issue_created",
		severity: "high",
		status: "task_created",
		reason_code: null,
		task_id: "88888888-8888-4888-8888-888888888888",
		received_at: new Date("2026-11-02T10:00:00.000Z"),
		title: "TypeError in checkout",
		summary: `${"x".repeat(MAX_DELIVERY_SUMMARY_CHARS)}overflow`,
		links: [
			{ label: "Sentry issue", url: "https://sentry.io/issues/1" },
			{ label: "Unsafe", url: "javascript:alert(1)" },
			{ label: "File", url: "file:///etc/passwd" },
		],
		repository_name: "acme/widgets",
	};

	test("caps the query and maps only safe links and bounded text", async () => {
		const { sql, calls } = fakeSql(
			dispatch({ deliveries: [deliveryRow, deliveryRow, deliveryRow] }),
		);
		const result = await readDeliveries(sql, ORG, { limit: 2 });
		expect(calls[0]?.parameters).toEqual([ORG, null, 3]);
		expect(result.deliveries).toHaveLength(2);
		expect(result.truncated).toBe(true);
		const [delivery] = result.deliveries;
		expect(delivery?.summary).toHaveLength(MAX_DELIVERY_SUMMARY_CHARS);
		expect(delivery?.links).toEqual([
			{ label: "Sentry issue", url: "https://sentry.io/issues/1" },
		]);
		expect(delivery?.repositoryName).toBe("acme/widgets");
	});

	test("drops rows with an unknown connector", async () => {
		const { sql } = fakeSql(
			dispatch({
				deliveries: [{ ...deliveryRow, connector_id: "jenkins" }],
			}),
		);
		const result = await readDeliveries(sql, ORG, { limit: 25 });
		expect(result.deliveries).toEqual([]);
	});
});

describe("mapping helpers", () => {
	test("safeText strips control characters and caps length", () => {
		expect(safeText("a\u0000b\nc", 10)).toBe("ab\nc");
		expect(safeText("abcdef", 3)).toBe("abc");
		expect(safeText(42, 10)).toBe("42");
		expect(safeText(null, 10)).toBe("");
	});

	test("parseSignalLinks accepts absolute http(s) only", () => {
		expect(
			parseSignalLinks([
				{ label: "ok", url: "https://example.test/a" },
				{ label: "", url: "https://example.test/b" },
				{ label: "bad", url: "javascript:alert(1)" },
				{ label: "relative", url: "/local" },
			]),
		).toEqual([{ label: "ok", url: "https://example.test/a" }]);
	});

	test("mapConnectionRow rejects revoked and unknown connectors", () => {
		expect(mapConnectionRow(connectionRow({ status: "revoked" }))).toBeNull();
		expect(
			mapConnectionRow(connectionRow({ connector_id: "jenkins" })),
		).toBeNull();
	});
});

describe("read SQL bounds", () => {
	test("every statement carries the tenant predicate and a LIMIT", () => {
		for (const statement of [
			INTEGRATION_CONNECTION_SQL,
			INTEGRATION_TRIGGER_COUNT_SQL,
			INTEGRATION_LAST_EVENT_SQL,
			INTEGRATION_USAGE_SQL,
			INTEGRATION_SUBSCRIPTIONS_SQL,
			INTEGRATION_DELIVERIES_SQL,
		]) {
			expect(statement).toContain("organization_id = $1");
			expect(statement).toContain("LIMIT");
		}
	});

	test("the connection read excludes revoked credentials", () => {
		expect(INTEGRATION_CONNECTION_SQL).toContain("cc.status <> 'revoked'");
	});
});
