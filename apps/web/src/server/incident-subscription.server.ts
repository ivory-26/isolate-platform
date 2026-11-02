import "@tanstack/react-start/server-only";
import {
	INCIDENT_SEVERITIES,
	type IncidentSeverity,
	type OrganizationId,
} from "@isolate/shared";

/**
 * Subscription-aware trigger policy (wave 23).
 *
 * An integration subscription is the durable answer to "which verified events
 * should become tasks, for which repository, and with how much autonomy?". The
 * matching here is pure so the policy table is the spec: connector, event kind,
 * environment allowlist, minimum severity, repository mapping and base branch.
 *
 * Default safe posture (mirrored by the 0016 column defaults):
 * - environment allowlist `["production"]`;
 * - minimum severity `high`;
 * - autonomy `A2` (prepare a fix);
 * - an empty `eventKinds` list means "every kind this connector emits".
 *
 * Nothing in this module reads the request. The org, connector and repository
 * always come from server-side records; the event descriptor is derived from a
 * verified payload or from the normalized signal.
 */

export const SUBSCRIPTION_AUTONOMY_LEVELS = ["A0", "A1", "A2", "A3"] as const;
export type SubscriptionAutonomyLevel =
	(typeof SUBSCRIPTION_AUTONOMY_LEVELS)[number];

export const DEFAULT_SUBSCRIPTION_ENVIRONMENTS = ["production"] as const;
export const DEFAULT_SUBSCRIPTION_MIN_SEVERITY = "high" as const;
export const DEFAULT_SUBSCRIPTION_AUTONOMY: SubscriptionAutonomyLevel = "A2";

export type IntegrationSubscriptionRecord = {
	id: string;
	organizationId: OrganizationId;
	/** Lowercase connector token, e.g. `github`, `sentry`, `grafana`. */
	connectorId: string;
	displayName: string;
	/** Empty means "the connector's default event set". */
	eventKinds: readonly string[];
	environmentAllowlist: readonly string[];
	minSeverity: IncidentSeverity;
	repositoryId: string | null;
	baseBranch: string | null;
	autonomyLevel: SubscriptionAutonomyLevel;
	enabled: boolean;
};

/** Server-side subscription reader; always tenant- and connector-scoped. */
export interface SubscriptionRegistry {
	listEnabled(input: {
		organizationId: OrganizationId;
		connectorId: string;
	}): Promise<IntegrationSubscriptionRecord[]>;
}

export type SubscriptionEventLifecycle =
	| "open"
	| "resolved"
	| "acknowledged"
	| "regression";

/**
 * The bounded event facts a subscription is matched against. `environment` is
 * the provider-declared environment when present; `production` is the
 * connector's own evidence (a production environment label, the repository
 * default branch, or a normalizer that only emits production alerts).
 */
export type SubscriptionEventDescriptor = {
	connectorId: string;
	eventKind: string;
	severity: IncidentSeverity;
	environment: string | null;
	production: boolean;
	/** Triggering ref, when the connector has one. */
	branch: string | null;
	/** Repository default branch, when the connector reports it. */
	baseBranch: string | null;
	lifecycle: SubscriptionEventLifecycle;
};

export type SubscriptionRejectionCode =
	| "SUBSCRIPTION_DISABLED"
	| "CONNECTOR_MISMATCH"
	| "EVENT_KIND_NOT_SUBSCRIBED"
	| "SEVERITY_BELOW_MINIMUM"
	| "ENVIRONMENT_NOT_ALLOWED"
	| "BASE_BRANCH_MISMATCH";

export type SubscriptionMatch =
	| { matched: true; subscription: IntegrationSubscriptionRecord }
	| { matched: false; reason: SubscriptionRejectionCode };

const SEVERITY_RANK: Readonly<Record<IncidentSeverity, number>> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
	info: 0,
};

const ENVIRONMENT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Lowercase, bounded environment token; anything else is unplaceable. */
export function normalizeEnvironmentToken(
	value: string | null | undefined,
): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	return ENVIRONMENT_TOKEN.test(trimmed) ? trimmed : null;
}

export function severityRank(severity: IncidentSeverity): number {
	return SEVERITY_RANK[severity] ?? 0;
}

export function isIncidentSeverity(value: unknown): value is IncidentSeverity {
	return (
		typeof value === "string" &&
		(INCIDENT_SEVERITIES as readonly string[]).includes(value)
	);
}

function environmentAllowed(
	allowlist: readonly string[],
	event: SubscriptionEventDescriptor,
): boolean {
	const normalized = allowlist
		.map((entry) => normalizeEnvironmentToken(entry))
		.filter((entry): entry is string => entry !== null);
	if (normalized.length === 0) return true;
	const declared = normalizeEnvironmentToken(event.environment);
	if (declared !== null) return normalized.includes(declared);
	// No provider-declared environment: only a connector that positively
	// established production may satisfy the production allowlist.
	return (
		event.production &&
		(normalized.includes("production") || normalized.includes("prod"))
	);
}

/**
 * Matches one subscription against one event. Order is intentional: cheap
 * identity checks first, then policy, so a rejection reason is deterministic
 * and never depends on provider text.
 */
export function matchSubscription(
	subscription: IntegrationSubscriptionRecord,
	event: SubscriptionEventDescriptor,
): SubscriptionMatch {
	if (!subscription.enabled) {
		return { matched: false, reason: "SUBSCRIPTION_DISABLED" };
	}
	if (subscription.connectorId !== event.connectorId) {
		return { matched: false, reason: "CONNECTOR_MISMATCH" };
	}
	if (
		subscription.eventKinds.length > 0 &&
		!subscription.eventKinds.includes(event.eventKind)
	) {
		return { matched: false, reason: "EVENT_KIND_NOT_SUBSCRIBED" };
	}
	if (severityRank(event.severity) < severityRank(subscription.minSeverity)) {
		return { matched: false, reason: "SEVERITY_BELOW_MINIMUM" };
	}
	if (!environmentAllowed(subscription.environmentAllowlist, event)) {
		return { matched: false, reason: "ENVIRONMENT_NOT_ALLOWED" };
	}
	// A branch-scoped subscription applies only when the connector reports a
	// branch. Connectors without branch metadata (issue/incident webhooks) are
	// repository-scoped, not branch-scoped.
	if (
		subscription.baseBranch !== null &&
		event.branch !== null &&
		event.branch !== subscription.baseBranch
	) {
		return { matched: false, reason: "BASE_BRANCH_MISMATCH" };
	}
	return { matched: true, subscription };
}

function specificity(
	subscription: IntegrationSubscriptionRecord,
): [number, number, string] {
	return [
		subscription.eventKinds.length > 0 ? 1 : 0,
		severityRank(subscription.minSeverity),
		subscription.id,
	];
}

/**
 * Picks the most specific enabled subscription that accepts the event. Returns
 * the rejection reason of the first non-disabled candidate when none matches,
 * so the delivery ledger explains why nothing happened.
 */
export function resolveSubscriptionMatch(
	subscriptions: readonly IntegrationSubscriptionRecord[],
	event: SubscriptionEventDescriptor,
): SubscriptionMatch {
	const candidates = subscriptions
		.filter(
			(subscription) =>
				subscription.enabled && subscription.connectorId === event.connectorId,
		)
		.sort((left, right) => {
			const a = specificity(left);
			const b = specificity(right);
			return b[0] - a[0] || b[1] - a[1] || (a[2] < b[2] ? -1 : 1);
		});
	if (candidates.length === 0) {
		const disabled = subscriptions.some(
			(subscription) =>
				subscription.connectorId === event.connectorId && !subscription.enabled,
		);
		return {
			matched: false,
			reason: disabled ? "SUBSCRIPTION_DISABLED" : "CONNECTOR_MISMATCH",
		};
	}
	let firstRejection: SubscriptionRejectionCode | null = null;
	for (const candidate of candidates) {
		const result = matchSubscription(candidate, event);
		if (result.matched) return result;
		if (firstRejection === null && result.reason !== "SUBSCRIPTION_DISABLED") {
			firstRejection = result.reason;
		}
	}
	return {
		matched: false,
		reason: firstRejection ?? "SUBSCRIPTION_DISABLED",
	};
}
