import "@tanstack/react-start/server-only";
import { createHash } from "node:crypto";
import {
	pagerDutyIncidentFingerprint,
	pagerDutySeverity,
	pagerDutyWebhookEnvelopeSchema,
	parseGrafanaAlertGroup,
	sentryIncidentFingerprint,
	sentryIncidentSeverity,
	sentryIssueWebhookSchema,
} from "@isolate/integrations";
import type {
	IncidentLink,
	IncidentSeverity,
	OrganizationId,
} from "@isolate/shared";
import { z } from "zod";

/**
 * Bounded event delivery ledger and connector event hints (wave 23).
 *
 * A delivery row is the audit receipt of one inbound event: connector,
 * subscription, provider delivery id, normalized kind/severity/fingerprint,
 * verification method, terminal status, reason code, signal/task links, the
 * sha256 of the raw body and the received/processed instants. It never carries
 * the body, headers, a credential or provider free text beyond the bounded
 * title/summary persisted on `incident_signals`.
 *
 * Dedupe is by provider delivery id: a repeat flips the surviving row to
 * `deduplicated` (keeping its task link) and creates no second row or task.
 */

export const EVENT_DELIVERY_STATUSES = [
	"received",
	"verified",
	"rejected",
	"deduplicated",
	"task_created",
	"task_updated",
	"ignored",
] as const;
export type EventDeliveryStatus = (typeof EVENT_DELIVERY_STATUSES)[number];

/** Statuses that a redelivery must not reopen (the work is already decided). */
const TERMINAL_DELIVERY_STATUSES: ReadonlySet<EventDeliveryStatus> = new Set([
	"deduplicated",
	"task_created",
	"task_updated",
	"ignored",
]);

export const EVENT_DELIVERY_VERIFICATIONS = [
	"provider_signature",
	"shared_hmac",
	"bridge_identity",
	"canonical_refetch",
] as const;
export type EventDeliveryVerification =
	(typeof EVENT_DELIVERY_VERIFICATIONS)[number];

/** Uppercase reason codes, matching the 0016 CHECK constraint. */
export const DELIVERY_REASON_CODES = [
	"NOT_AN_INCIDENT",
	"TRIGGER_POLICY_REJECTED",
	"DUPLICATE_DELIVERY",
	"DUPLICATE_FINGERPRINT",
	"THROTTLED",
	"NO_SUBSCRIPTION_MATCH",
	"SUBSCRIPTION_DISABLED",
	"CONNECTOR_MISMATCH",
	"EVENT_KIND_NOT_SUBSCRIBED",
	"SEVERITY_BELOW_MINIMUM",
	"ENVIRONMENT_NOT_ALLOWED",
	"BASE_BRANCH_MISMATCH",
	"REPOSITORY_UNMAPPED",
	"TENANT_MISMATCH",
	"AUTONOMY_OBSERVE_ONLY",
	"AUTONOMY_LEVEL_UNSUPPORTED",
	"LIFECYCLE_UPDATE",
	"LIFECYCLE_UNMATCHED",
	"TASK_SUBMISSION_FAILED",
	"INVALID_PAYLOAD",
	"SIGNATURE_REJECTED",
] as const;
export type DeliveryReasonCode = (typeof DELIVERY_REASON_CODES)[number];

const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isDeliveryReasonCode(value: string): boolean {
	return REASON_CODE_PATTERN.test(value);
}

export type EventDeliveryRecordInput = {
	organizationId: OrganizationId;
	connectorId: string;
	subscriptionId: string | null;
	deliveryId: string | null;
	source: string;
	eventKind: string;
	severity: IncidentSeverity;
	fingerprint: string;
	verification: EventDeliveryVerification;
	status: EventDeliveryStatus;
	reasonCode: DeliveryReasonCode | null;
	signalId: string | null;
	taskId: string | null;
	bodySha256: string;
	receivedAt: Date;
	processedAt: Date | null;
};

export type EventDeliveryRecordResult = {
	id: string;
	/** True when this delivery id was already recorded. */
	duplicate: boolean;
	/** Task already linked to the surviving row, for the deduped response. */
	priorTaskId: string | null;
};

export type EventDeliveryFinalizeInput = {
	organizationId: OrganizationId;
	id: string;
	status: EventDeliveryStatus;
	reasonCode: DeliveryReasonCode | null;
	signalId: string | null;
	taskId: string | null;
	/** Set once the delivery is matched to a subscription (null keeps it). */
	subscriptionId?: string | null;
	processedAt: Date;
};

export type SignalDisplayInput = {
	organizationId: OrganizationId;
	signalId: string;
	title: string;
	summary: string;
	links: readonly IncidentLink[];
};

/**
 * Storage seam for the delivery ledger. The Postgres implementation lives in
 * `incident-delivery-postgres.server.ts` (parameterized SQL, no repository
 * package dependency); tests and local mode use the in-memory form below.
 */
export interface EventDeliveryLedger {
	record(input: EventDeliveryRecordInput): Promise<EventDeliveryRecordResult>;
	finalize(input: EventDeliveryFinalizeInput): Promise<void>;
	/** Bounded display fields on the 0016 `incident_signals` columns. */
	attachSignalDisplay(input: SignalDisplayInput): Promise<void>;
	/** Latest task linked to a connector fingerprint, for lifecycle updates. */
	findLatestTask(input: {
		organizationId: OrganizationId;
		connectorId: string;
		fingerprint: string;
	}): Promise<string | null>;
}

const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function normalizeDeliveryId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return DELIVERY_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function sha256Hex(rawBody: string | Uint8Array): string {
	return createHash("sha256")
		.update(typeof rawBody === "string" ? rawBody : Buffer.from(rawBody))
		.digest("hex");
}

/** Fingerprint fallback for deliveries with no source-stable identity. */
export function deliveryBodyFingerprint(rawBody: string | Uint8Array): string {
	return `sha256:${sha256Hex(rawBody)}`;
}

function boundedLine(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxChars
		? normalized
		: normalized.slice(0, maxChars);
}

type StoredDelivery = EventDeliveryRecordInput & { id: string };

/**
 * In-memory ledger used by tests, local mode and any single-process deployment
 * that has not wired the SQL store. It implements the same duplicate rule as
 * the unique index: one row per `(organization, connector, delivery id)`.
 */
export function createInMemoryEventDeliveryLedger(): EventDeliveryLedger & {
	rows(): StoredDelivery[];
	signalDisplays(): SignalDisplayInput[];
} {
	const rows: StoredDelivery[] = [];
	const byDeliveryId = new Map<string, StoredDelivery>();
	const displays: SignalDisplayInput[] = [];
	const keyOf = (
		organizationId: string,
		connectorId: string,
		deliveryId: string,
	) => `${organizationId}:${connectorId}:${deliveryId}`;

	return {
		async record(input) {
			const deliveryId = input.deliveryId;
			if (deliveryId !== null) {
				const existing = byDeliveryId.get(
					keyOf(input.organizationId, input.connectorId, deliveryId),
				);
				if (
					existing !== undefined &&
					TERMINAL_DELIVERY_STATUSES.has(existing.status)
				) {
					existing.status = "deduplicated";
					existing.reasonCode = "DUPLICATE_DELIVERY";
					existing.processedAt = input.receivedAt;
					return {
						id: existing.id,
						duplicate: true,
						priorTaskId: existing.taskId,
					};
				}
				if (existing !== undefined) {
					// A prior attempt stopped before a terminal decision: process
					// the same row again instead of suppressing the event.
					return { id: existing.id, duplicate: false, priorTaskId: null };
				}
			}
			const row: StoredDelivery = {
				...input,
				id: crypto.randomUUID(),
			};
			rows.push(row);
			if (deliveryId !== null) {
				byDeliveryId.set(
					keyOf(input.organizationId, input.connectorId, deliveryId),
					row,
				);
			}
			return { id: row.id, duplicate: false, priorTaskId: null };
		},
		async finalize(input) {
			const row = rows.find(
				(candidate) =>
					candidate.id === input.id &&
					candidate.organizationId === input.organizationId,
			);
			if (row === undefined) return;
			row.status = input.status;
			row.reasonCode = input.reasonCode;
			row.signalId = input.signalId;
			row.taskId = input.taskId;
			if (input.subscriptionId !== undefined && input.subscriptionId !== null) {
				row.subscriptionId = input.subscriptionId;
			}
			row.processedAt = input.processedAt;
		},
		async attachSignalDisplay(input) {
			displays.push(input);
		},
		async findLatestTask(input) {
			let latest: StoredDelivery | null = null;
			for (const row of rows) {
				if (
					row.organizationId !== input.organizationId ||
					row.connectorId !== input.connectorId ||
					row.fingerprint !== input.fingerprint ||
					row.taskId === null
				) {
					continue;
				}
				if (
					latest === null ||
					row.receivedAt.getTime() > latest.receivedAt.getTime()
				) {
					latest = row;
				}
			}
			return latest?.taskId ?? null;
		},
		rows: () => [...rows],
		signalDisplays: () => [...displays],
	};
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function textOf(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function environmentOfLabels(labels: Record<string, unknown>): string | null {
	for (const [name, value] of Object.entries(labels)) {
		if (
			!["environment", "env", "deployment_environment"].includes(
				name.toLowerCase(),
			)
		)
			continue;
		const text = textOf(value);
		if (text !== null) return text.toLowerCase().slice(0, 64);
	}
	return null;
}

export type ConnectorEventHints = {
	environment: string | null;
	production: boolean;
	branch: string | null;
	baseBranch: string | null;
	lifecycle: "open" | "resolved" | "acknowledged";
	/** Computed for lifecycle deliveries that have no normalized signal. */
	fingerprint: string | null;
	severity: IncidentSeverity;
};

const EMPTY_HINTS: ConnectorEventHints = {
	environment: null,
	production: false,
	branch: null,
	baseBranch: null,
	lifecycle: "open",
	fingerprint: null,
	severity: "info",
};

/**
 * GitHub hints: the triggering ref, the repository default branch and any
 * explicitly declared environment. A ref that *is* the default branch is the
 * deployed line, so it satisfies the production allowlist; a feature branch
 * does not. Only allowlisted payload fields are read.
 */
export function githubEventHints(
	payload: unknown,
	signalSeverity: IncidentSeverity | null,
): ConnectorEventHints {
	const root = recordOf(payload);
	const repository = recordOf(root?.repository);
	const box = recordOf(root?.workflow_run) ?? recordOf(root?.check_suite) ?? {};
	const defaultBranch = textOf(repository?.default_branch);
	const branch = textOf(box.head_branch) ?? defaultBranch;
	const runEnvironment = recordOf(box.environment);
	const payloadEnvironment = recordOf(root?.environment);
	const environment =
		textOf(runEnvironment?.name) ??
		textOf(box.deployment_environment) ??
		textOf(payloadEnvironment?.name) ??
		textOf(root?.deployment_environment);
	const onDefault =
		defaultBranch !== null &&
		(branch === defaultBranch || textOf(box.head_branch) === null);
	const normalizedEnvironment = environment?.toLowerCase().slice(0, 64) ?? null;
	const isProductionEnvironment =
		normalizedEnvironment === "production" || normalizedEnvironment === "prod";
	return {
		environment: normalizedEnvironment ?? (onDefault ? "production" : null),
		production: isProductionEnvironment || onDefault,
		branch,
		baseBranch: defaultBranch,
		lifecycle: "open",
		fingerprint: null,
		severity: signalSeverity ?? "info",
	};
}

/** Sentry issue webhooks are project-scoped; the runbook binds production. */
export function sentryEventHints(payload: unknown): ConnectorEventHints {
	const parsed = sentryIssueWebhookSchema.safeParse(payload);
	if (!parsed.success) return EMPTY_HINTS;
	const data = parsed.data;
	const action = data.action;
	const lifecycle =
		action === "resolved" || action === "archived" || action === "ignored"
			? "resolved"
			: action === "assigned"
				? "acknowledged"
				: "open";
	const orgSlug = textOf(data.organization?.slug);
	const projectSlug =
		textOf(data.project?.slug) ?? textOf(data.issue.project?.slug);
	const projectId =
		textOf(data.project?.id) ?? textOf(data.issue.project?.id) ?? projectSlug;
	const issueId = textOf(data.issue.id);
	const fingerprint =
		orgSlug !== null &&
		projectSlug !== null &&
		projectId !== null &&
		issueId !== null
			? sentryIncidentFingerprint({ orgSlug, projectId, issueId })
			: null;
	return {
		environment: null,
		production: true,
		branch: null,
		baseBranch: null,
		lifecycle,
		fingerprint,
		severity: sentryIncidentSeverity(data.issue.level ?? null),
	};
}

/** PagerDuty incidents are service-scoped; the integration key binds them. */
export function pagerDutyEventHints(payload: unknown): ConnectorEventHints {
	const parsed = pagerDutyWebhookEnvelopeSchema.safeParse(payload);
	if (!parsed.success) return EMPTY_HINTS;
	const eventType = parsed.data.event.event_type;
	const lifecycle =
		eventType === "incident.resolved"
			? "resolved"
			: eventType === "incident.triggered"
				? "open"
				: "acknowledged";
	return {
		environment: null,
		production: true,
		branch: null,
		baseBranch: null,
		lifecycle,
		fingerprint: pagerDutyIncidentFingerprint({
			serviceId: parsed.data.event.data.service.id,
			incidentId: parsed.data.event.data.id,
		}),
		severity: pagerDutySeverity({
			urgency: parsed.data.event.data.urgency ?? null,
			priorityName: parsed.data.event.data.priority?.name ?? null,
		}),
	};
}

/**
 * Grafana alerts are environment-labelled, but the normalizer already refuses
 * every non-production firing alert, so an emitted signal is production. A
 * resolved group keeps its labels for environment matching.
 */
export function grafanaEventHints(payload: unknown): ConnectorEventHints {
	const group = parseGrafanaAlertGroup(payload);
	if (group === null) return EMPTY_HINTS;
	const firstAlert = group.alerts[0];
	const labels =
		recordOf(firstAlert?.labels) ?? recordOf(group.commonLabels) ?? {};
	const environment = environmentOfLabels(labels);
	return {
		environment: environment ?? "production",
		production: true,
		branch: null,
		baseBranch: null,
		lifecycle: group.status === "resolved" ? "resolved" : "open",
		fingerprint: null,
		severity: "info",
	};
}

/** Bounded display text for the 0016 signal columns. */
export const MAX_DELIVERY_TITLE_CHARS = 400;
export const MAX_DELIVERY_SUMMARY_CHARS = 8000;

export function boundedSignalDisplay(
	title: string,
	summary: string,
	links: readonly IncidentLink[],
): { title: string; summary: string; links: IncidentLink[] } {
	return {
		title: boundedLine(title, MAX_DELIVERY_TITLE_CHARS),
		summary: summary.slice(0, MAX_DELIVERY_SUMMARY_CHARS),
		links: links.slice(0, 10).map((link) => ({
			label: boundedLine(link.label, 120),
			url: link.url.slice(0, 512),
		})),
	};
}

/** Strict runtime lookups for the ledger's bounded columns. */
const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);

export function isIncidentSeverityValue(
	value: unknown,
): value is IncidentSeverity {
	return severitySchema.safeParse(value).success;
}
