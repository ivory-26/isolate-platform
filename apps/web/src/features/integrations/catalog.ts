import {
	CONNECTOR_IDS,
	CONNECTOR_LABELS,
	type ConnectorAuthKind,
	type ConnectorId,
} from "../devices/contracts";

/**
 * Client-safe static catalog for the ten supported connectors.
 *
 * This file carries display metadata only: no provider secret, endpoint,
 * credential reference or account identifier. Each connector keeps its three
 * capabilities separate — an event source, a context provider and an action
 * provider — because the product must let a customer enable one without the
 * others (docs/spec.md §3).
 */

export const INTEGRATION_CATEGORIES = [
	"source control/CI",
	"incidents",
	"observability",
	"metrics/APM",
	"logs/traces",
	"kubernetes/deploy",
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export type IntegrationCapabilities = {
	readonly eventSource: boolean;
	readonly context: boolean;
	readonly actions: boolean;
};

export type IntegrationToolRisk = "read_only" | "scoped_write" | "sensitive";

export type IntegrationToolDescriptor = {
	readonly name: string;
	readonly risk: IntegrationToolRisk;
	readonly description: string;
};

/**
 * `github_app` means the connector is authorized by the Isolate GitHub App and
 * the repository import flow; it never needs a relay-held provider key.
 * `relay` means the credential is entered on the relay's loopback pairing page.
 */
export type IntegrationPairingMode = "github_app" | "relay";

export type IntegrationCatalogEntry = {
	readonly id: ConnectorId;
	readonly label: string;
	readonly category: IntegrationCategory;
	readonly description: string;
	readonly capabilities: IntegrationCapabilities;
	readonly defaultAuthKind: ConnectorAuthKind;
	readonly pairingMode: IntegrationPairingMode;
	readonly eventKinds: readonly string[];
	readonly readTools: readonly IntegrationToolDescriptor[];
	readonly actionTools: readonly IntegrationToolDescriptor[];
	readonly freeTier: string;
	readonly docsPath: string;
	readonly credentialHint: string;
};

export const INTEGRATION_CATALOG: readonly IntegrationCatalogEntry[] = [
	{
		id: "github",
		label: CONNECTOR_LABELS.github,
		category: "source control/CI",
		description:
			"Failed Actions runs, failing check suites and repository evidence, plus scoped comments and reruns.",
		capabilities: { eventSource: true, context: true, actions: true },
		defaultAuthKind: "bot_token",
		pairingMode: "github_app",
		eventKinds: [
			"workflow_run.failure",
			"workflow_run.timed_out",
			"check_suite.failure",
		],
		readTools: [
			{
				name: "github.actions_context",
				risk: "read_only",
				description: "Job names and failed step names for one workflow run.",
			},
			{
				name: "github.check_context",
				risk: "read_only",
				description: "Check-suite conclusion and app identity for a commit.",
			},
			{
				name: "github.commit_context",
				risk: "read_only",
				description: "Commit metadata and changed-file ownership.",
			},
		],
		actionTools: [
			{
				name: "github.comment",
				risk: "scoped_write",
				description: "Comment on an issue or pull request; audited.",
			},
			{
				name: "github.rerun_workflow",
				risk: "scoped_write",
				description: "Rerun one failed workflow; audited.",
			},
		],
		freeTier:
			"GitHub Free; installation tokens allow 5,000 requests/hour and Actions logs are kept 90 days.",
		docsPath: "docs/connectors/github.md",
		credentialHint:
			"Authorized through the Isolate GitHub App during setup. No personal token or provider key is stored in Isolate.",
	},
	{
		id: "sentry",
		label: CONNECTOR_LABELS.sentry,
		category: "observability",
		description:
			"Issue creation and regression signals with bounded stack-trace and release context.",
		capabilities: { eventSource: true, context: true, actions: false },
		defaultAuthKind: "api_key",
		pairingMode: "relay",
		eventKinds: ["issue_created", "issue_unresolved"],
		readTools: [
			{
				name: "sentry.list_issues",
				risk: "read_only",
				description: "Issues for one project in the incident window.",
			},
			{
				name: "sentry.get_issue",
				risk: "read_only",
				description: "Issue status, counts and bounded metadata.",
			},
			{
				name: "sentry.latest_event",
				risk: "read_only",
				description: "Latest event with a redacted stack-trace excerpt.",
			},
		],
		actionTools: [],
		freeTier:
			"Free: 5,000 errors and 50 replays per month, 30-day retention, one user.",
		docsPath: "docs/connectors/sentry.md",
		credentialHint:
			"Create an internal integration token with event and project read scopes; paste it on the relay page.",
	},
	{
		id: "grafana",
		label: CONNECTOR_LABELS.grafana,
		category: "observability",
		description:
			"Alert firing signals with dashboard query and alert-rule context.",
		capabilities: { eventSource: true, context: true, actions: false },
		defaultAuthKind: "api_key",
		pairingMode: "relay",
		eventKinds: ["alert_firing", "alert_resolved", "alert_nodata"],
		readTools: [
			{
				name: "grafana.query_metrics",
				risk: "read_only",
				description: "Bounded Prometheus window for one service.",
			},
			{
				name: "grafana.query_logs",
				risk: "read_only",
				description: "Redacted Loki tail, capped at 200 lines.",
			},
			{
				name: "grafana.get_alert_rule",
				risk: "read_only",
				description: "Rule metadata and bounded annotations for one UID.",
			},
		],
		actionTools: [],
		freeTier:
			"Cloud Free: 10k series, 50 GB logs and traces per month, 14-day retention; Grafana OSS self-hosting is free.",
		docsPath: "docs/connectors/grafana.md",
		credentialHint:
			"Create a service-account token with the Viewer role; enter it with your Grafana base URL on the relay page.",
	},
	{
		id: "pagerduty",
		label: CONNECTOR_LABELS.pagerduty,
		category: "incidents",
		description:
			"Incident triggers and on-call context, with audited acknowledge and resolve actions.",
		capabilities: { eventSource: true, context: true, actions: true },
		defaultAuthKind: "api_key",
		pairingMode: "relay",
		eventKinds: [
			"incident.triggered",
			"incident.acknowledged",
			"incident.escalated",
			"incident.resolved",
		],
		readTools: [
			{
				name: "pagerduty.list_incidents",
				risk: "read_only",
				description: "Incidents for one service and time window.",
			},
			{
				name: "pagerduty.get_incident",
				risk: "read_only",
				description: "Incident status, urgency and assignments.",
			},
			{
				name: "pagerduty.list_log_entries",
				risk: "read_only",
				description: "Bounded incident log entries.",
			},
		],
		actionTools: [
			{
				name: "pagerduty.acknowledge",
				risk: "scoped_write",
				description: "Acknowledge one incident; audited.",
			},
			{
				name: "pagerduty.resolve",
				risk: "scoped_write",
				description: "Resolve one incident; audited.",
			},
		],
		freeTier:
			"Free: five users, one schedule, one escalation policy, 100 SMS per month; the REST API is included.",
		docsPath: "docs/connectors/pagerduty.md",
		credentialHint:
			"Create a read-only REST API key at PagerDuty, or an OAuth client; paste it on the relay page.",
	},
	{
		id: "kubernetes",
		label: CONNECTOR_LABELS.kubernetes,
		category: "kubernetes/deploy",
		description:
			"Warning events, pod status, rollout state and redacted log tails from a read-only ServiceAccount.",
		capabilities: { eventSource: false, context: true, actions: true },
		defaultAuthKind: "service_account_json",
		pairingMode: "relay",
		eventKinds: [
			"kubernetes_warning",
			"pod_oomkilled",
			"pod_crashloop",
			"image_pull_failed",
		],
		readTools: [
			{
				name: "k8s.list_events",
				risk: "read_only",
				description: "Warning events for one owner object, at most 50.",
			},
			{
				name: "k8s.get_pod",
				risk: "read_only",
				description: "Pod status and container states, no spec dump.",
			},
			{
				name: "k8s.get_deployment",
				risk: "read_only",
				description: "Replica and rollout status for one deployment.",
			},
			{
				name: "k8s.logs_tail",
				risk: "read_only",
				description: "Redacted log tail, at most 200 lines, no follow.",
			},
		],
		actionTools: [
			{
				name: "k8s.rollout_restart",
				risk: "sensitive",
				description: "Restart a rollout; requires an exact-payload approval.",
			},
			{
				name: "k8s.scale",
				risk: "sensitive",
				description: "Scale a workload; requires an exact-payload approval.",
			},
		],
		freeTier:
			"Open source and self-hosted; no vendor quota. The API server retains events for about one hour by default.",
		docsPath: "docs/connectors/kubernetes.md",
		credentialHint:
			"Use a namespace-scoped ServiceAccount with get/list/watch on pods, events, deployments and pods/log.",
	},
	{
		id: "datadog",
		label: CONNECTOR_LABELS.datadog,
		category: "metrics/APM",
		description:
			"Monitor transitions with metric windows, log aggregates and incident context.",
		capabilities: { eventSource: true, context: true, actions: false },
		defaultAuthKind: "api_key",
		pairingMode: "relay",
		eventKinds: ["alert_firing"],
		readTools: [
			{
				name: "datadog.query_metrics",
				risk: "read_only",
				description: "Bounded metric window for one service.",
			},
			{
				name: "datadog.search_logs",
				risk: "read_only",
				description: "Aggregated log status codes, no raw log bodies.",
			},
			{
				name: "datadog.get_incident",
				risk: "read_only",
				description: "Incident severity and state.",
			},
			{
				name: "datadog.get_monitor",
				risk: "read_only",
				description: "Monitor definition and current state.",
			},
		],
		actionTools: [],
		freeTier:
			"Free: five hosts, one-day metric retention; no free log allowance is stated.",
		docsPath: "docs/connectors/datadog.md",
		credentialHint:
			"Create an API key and an application key with metrics and logs read scopes; paste both on the relay page.",
	},
	{
		id: "newrelic",
		label: CONNECTOR_LABELS.newrelic,
		category: "metrics/APM",
		description:
			"Alert activations with NRQL query results and entity context.",
		capabilities: { eventSource: true, context: true, actions: false },
		defaultAuthKind: "api_key",
		pairingMode: "relay",
		eventKinds: ["alert_activated"],
		readTools: [
			{
				name: "newrelic.run_nrql",
				risk: "read_only",
				description: "One bounded NRQL query for the incident window.",
			},
			{
				name: "newrelic.get_entity",
				risk: "read_only",
				description: "Entity identity and bounded tags.",
			},
			{
				name: "newrelic.list_alert_policies",
				risk: "read_only",
				description: "Alert policies attached to the entity.",
			},
		],
		actionTools: [],
		freeTier:
			"Free: 100 GB ingest per month, one full user, at least eight-day retention.",
		docsPath: "docs/connectors/newrelic.md",
		credentialHint:
			"Create a User API key with NerdGraph read access; paste it on the relay page.",
	},
	{
		id: "honeycomb",
		label: CONNECTOR_LABELS.honeycomb,
		category: "logs/traces",
		description: "Trigger events with bounded query results and SLO context.",
		capabilities: { eventSource: true, context: true, actions: false },
		defaultAuthKind: "api_key",
		pairingMode: "relay",
		eventKinds: ["trigger_triggered"],
		readTools: [
			{
				name: "honeycomb.run_query",
				risk: "read_only",
				description: "One bounded query for the incident window.",
			},
			{
				name: "honeycomb.get_trigger",
				risk: "read_only",
				description: "Trigger definition and current state.",
			},
			{
				name: "honeycomb.list_slos",
				risk: "read_only",
				description: "SLO burn status for the dataset.",
			},
		],
		actionTools: [],
		freeTier:
			"Free: 20M events and 100M points per month, two triggers, 60-day event retention.",
		docsPath: "docs/connectors/honeycomb.md",
		credentialHint:
			"Create an Environment API key with query and trigger read access; paste it on the relay page.",
	},
	{
		id: "axiom",
		label: CONNECTOR_LABELS.axiom,
		category: "logs/traces",
		description: "Monitor alerts with APL query results and dataset context.",
		capabilities: { eventSource: true, context: true, actions: false },
		defaultAuthKind: "api_key",
		pairingMode: "relay",
		eventKinds: ["monitor_alert"],
		readTools: [
			{
				name: "axiom.query_apl",
				risk: "read_only",
				description: "One bounded APL query for the incident window.",
			},
			{
				name: "axiom.get_monitor",
				risk: "read_only",
				description: "Monitor definition and current state.",
			},
			{
				name: "axiom.list_datasets",
				risk: "read_only",
				description: "Dataset names and retention metadata.",
			},
		],
		actionTools: [],
		freeTier:
			"Free: 500 GB load and 25 GB storage per month, 30 days, three datasets, one user.",
		docsPath: "docs/connectors/axiom.md",
		credentialHint:
			"Create an API token with dataset and query permissions; paste it on the relay page.",
	},
	{
		id: "signoz",
		label: CONNECTOR_LABELS.signoz,
		category: "logs/traces",
		description:
			"Alert firing signals with query-range results and alert-rule context.",
		capabilities: { eventSource: true, context: true, actions: false },
		defaultAuthKind: "self_host_url_token",
		pairingMode: "relay",
		eventKinds: ["alert_firing"],
		readTools: [
			{
				name: "signoz.query_range",
				risk: "read_only",
				description: "One bounded metric or trace query.",
			},
			{
				name: "signoz.get_rule",
				risk: "read_only",
				description: "Alert-rule definition for one id.",
			},
			{
				name: "signoz.list_rules",
				risk: "read_only",
				description: "Alert rules in the workspace.",
			},
		],
		actionTools: [],
		freeTier:
			"SigNoz Community self-hosting is free with no data cap; SigNoz Cloud has no free tier.",
		docsPath: "docs/connectors/signoz.md",
		credentialHint:
			"Create a SigNoz API key for your self-hosted base URL; enter both on the relay page.",
	},
];

const CATALOG_BY_ID: ReadonlyMap<string, IntegrationCatalogEntry> = new Map(
	INTEGRATION_CATALOG.map((entry) => [entry.id, entry]),
);

export function integrationCatalogEntry(
	connectorId: string,
): IntegrationCatalogEntry | undefined {
	return CATALOG_BY_ID.get(connectorId);
}

/** Grouped display order; never derived from the catalog array by accident. */
export function groupIntegrationCatalog(
	entries: readonly IntegrationCatalogEntry[] = INTEGRATION_CATALOG,
): { category: IntegrationCategory; entries: IntegrationCatalogEntry[] }[] {
	return INTEGRATION_CATEGORIES.map((category) => ({
		category,
		entries: entries.filter((entry) => entry.category === category),
	})).filter((group) => group.entries.length > 0);
}

/** True only for an event kind the connector's normalizer actually emits. */
export function isKnownEventKind(
	connectorId: string,
	eventKind: string,
): boolean {
	return (
		integrationCatalogEntry(connectorId)?.eventKinds.includes(eventKind) ??
		false
	);
}

export function knownConnectorIds(): readonly ConnectorId[] {
	return CONNECTOR_IDS;
}
