import { z } from "zod";
import {
	CONNECTOR_AUTH_KINDS,
	CONNECTOR_IDS,
	type ConnectorAuthKind,
	type ConnectorId,
	connectorCredentialStatusSchema,
} from "../devices/contracts";
import { repositoryDefaultBranchSchema } from "../repositories/contracts";
import {
	INTEGRATION_CATALOG,
	INTEGRATION_CATEGORIES,
	type IntegrationCapabilities,
	integrationCatalogEntry,
} from "./catalog";

/**
 * Client-safe view contracts for the integration surfaces.
 *
 * Every schema is strict and bounded so a malformed or oversized server payload
 * fails closed. No schema has a field for a provider secret, a device token, a
 * credential reference's contents or a raw delivery body.
 */

/* -------------------------------------------------------------------------- */
/* Shared enumerations                                                        */
/* -------------------------------------------------------------------------- */

export const INTEGRATION_TABS = ["catalog", "connected", "relays"] as const;
export const integrationTabSchema = z.enum(INTEGRATION_TABS);
export type IntegrationTab = z.infer<typeof integrationTabSchema>;

export type IntegrationsSearch = { tab: IntegrationTab };

/** Pure URL-search parser: an unknown tab falls back to the catalog. */
export function parseIntegrationsSearch(
	search: Record<string, unknown>,
): IntegrationsSearch {
	if (search.tab === "connected" || search.tab === "relays") {
		return { tab: search.tab };
	}
	return { tab: "catalog" };
}

export const SEVERITIES = [
	"critical",
	"high",
	"medium",
	"low",
	"info",
] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

/** A1 is explicitly unsupported and is not offered for new rules. */
export const AUTONOMY_LEVELS = ["A0", "A2", "A3"] as const;
export const autonomyLevelSchema = z.enum(AUTONOMY_LEVELS);
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

export const UNSUPPORTED_AUTONOMY_LEVELS = ["A1"] as const;
export const storedAutonomyLevelSchema = z.enum(["A0", "A1", "A2", "A3"]);
export type StoredAutonomyLevel = z.infer<typeof storedAutonomyLevelSchema>;

export const AUTONOMY_LABELS: Record<StoredAutonomyLevel, string> = {
	A0: "A0 Observe",
	A1: "A1 Investigate (unsupported)",
	A2: "A2 Prepare fix",
	A3: "A3 Propose PR",
};

export const AUTONOMY_DESCRIPTIONS: Record<StoredAutonomyLevel, string> = {
	A0: "Record and show the event. No agent task is created.",
	A1: "Diagnose with read-only evidence and no code change. Unsupported; not selectable.",
	A2: "Clone, edit and validate in a Modal sandbox. Nothing is pushed.",
	A3: "Push a branch and open a pull request through exact-payload approvals.",
};

export const DELIVERY_STATUSES = [
	"received",
	"verified",
	"rejected",
	"deduplicated",
	"task_created",
	"task_updated",
	"ignored",
] as const;
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
	received: "Received",
	verified: "Verified",
	rejected: "Rejected",
	deduplicated: "Deduplicated",
	task_created: "Task created",
	task_updated: "Task updated",
	ignored: "Ignored",
};

export const PAIRING_STATUSES = [
	"pending",
	"claimed",
	"completed",
	"expired",
	"cancelled",
] as const;
export const pairingStatusSchema = z.enum(PAIRING_STATUSES);
export type PairingStatus = z.infer<typeof pairingStatusSchema>;

export const PAIRING_STATUS_LABELS: Record<PairingStatus, string> = {
	pending: "Waiting for the relay",
	claimed: "Relay claimed the code",
	completed: "Stored on relay",
	expired: "Code expired",
	cancelled: "Cancelled",
};

export const RELAY_STATUSES = ["pending", "active", "revoked"] as const;
export const relayStatusSchema = z.enum(RELAY_STATUSES);
export type RelayStatus = z.infer<typeof relayStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

export const MAX_EVENT_KINDS = 16;
export const MAX_ENVIRONMENTS = 16;
export const MAX_SUBSCRIPTIONS_PER_CONNECTOR = 50;
export const MAX_DELIVERIES_PER_READ = 100;
export const DEFAULT_DELIVERIES_PER_READ = 25;
export const MAX_DELIVERY_SUMMARY_CHARS = 2_000;
export const MAX_SIGNAL_LINKS = 5;
export const MAX_CONNECTOR_TOOLS = 64;

/* -------------------------------------------------------------------------- */
/* Connection / summary                                                       */
/* -------------------------------------------------------------------------- */

export const integrationConnectionSchema = z.strictObject({
	id: z.uuid(),
	connectorId: z.enum(CONNECTOR_IDS),
	displayName: z.string().min(1).max(100),
	authKind: z.enum(CONNECTOR_AUTH_KINDS),
	status: connectorCredentialStatusSchema,
	relayId: z.uuid(),
	relayName: z.string().min(1).max(100),
	relayStatus: relayStatusSchema,
	scopes: z.array(z.string().min(1).max(64)).max(32),
	enabledTools: z.array(z.string().min(1).max(64)).max(MAX_CONNECTOR_TOOLS),
	lastValidatedAt: z.string().nullable(),
	lastUsedAt: z.string().nullable(),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

export const integrationUsageSchema = z.strictObject({
	requestsThisPeriod: z.number().int().nonnegative(),
	period: z.string().max(32).nullable(),
});
export type IntegrationUsage = z.infer<typeof integrationUsageSchema>;

export const integrationCapabilitiesSchema = z.strictObject({
	eventSource: z.boolean(),
	context: z.boolean(),
	actions: z.boolean(),
});

export const integrationSummarySchema = z.strictObject({
	connectorId: z.enum(CONNECTOR_IDS),
	label: z.string().min(1).max(64),
	category: z.enum(INTEGRATION_CATEGORIES),
	capabilities: integrationCapabilitiesSchema,
	pairingMode: z.enum(["github_app", "relay"]),
	connection: integrationConnectionSchema.nullable(),
	triggerCount: z.number().int().nonnegative(),
	enabledTriggerCount: z.number().int().nonnegative(),
	lastEventAt: z.string().nullable(),
	usage: integrationUsageSchema,
});
export type IntegrationSummary = z.infer<typeof integrationSummarySchema>;

export const integrationListSchema = z.strictObject({
	integrations: z
		.array(integrationSummarySchema)
		.max(INTEGRATION_CATALOG.length),
	canManage: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/* Subscription                                                               */
/* -------------------------------------------------------------------------- */

const eventKindSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_.:-]{0,63}$/);

const environmentSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const integrationSubscriptionSchema = z.strictObject({
	id: z.uuid(),
	connectorId: z.enum(CONNECTOR_IDS),
	displayName: z.string().min(1).max(100),
	eventKinds: z.array(eventKindSchema).max(MAX_EVENT_KINDS),
	environmentAllowlist: z.array(environmentSchema).max(MAX_ENVIRONMENTS),
	minSeverity: severitySchema,
	repositoryId: z.uuid().nullable(),
	repositoryName: z.string().min(1).max(200).nullable(),
	baseBranch: z.string().min(1).max(255).nullable(),
	autonomyLevel: storedAutonomyLevelSchema,
	enabled: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type IntegrationSubscription = z.infer<
	typeof integrationSubscriptionSchema
>;

export const saveSubscriptionSchema = z
	.strictObject({
		/** Present when updating an existing rule. */
		id: z.uuid().optional(),
		connectorId: z.enum(CONNECTOR_IDS),
		displayName: z.string().trim().min(1).max(100),
		eventKinds: z.array(eventKindSchema).max(MAX_EVENT_KINDS).default([]),
		environmentAllowlist: z
			.array(environmentSchema)
			.max(MAX_ENVIRONMENTS)
			.default(["production"]),
		minSeverity: severitySchema.default("high"),
		repositoryId: z.uuid().nullable().default(null),
		baseBranch: repositoryDefaultBranchSchema.nullable().default(null),
		autonomyLevel: autonomyLevelSchema.default("A2"),
		enabled: z.boolean().default(true),
	})
	.superRefine((value, ctx) => {
		for (const kind of value.eventKinds) {
			if (
				integrationCatalogEntry(value.connectorId)?.eventKinds.includes(
					kind,
				) !== true
			) {
				ctx.addIssue({
					code: "custom",
					path: ["eventKinds"],
					message: `The ${value.connectorId} connector does not emit "${kind}".`,
				});
				break;
			}
		}
		if (value.autonomyLevel !== "A0" && value.repositoryId === null) {
			ctx.addIssue({
				code: "custom",
				path: ["repositoryId"],
				message:
					"A2 and A3 rules need an imported repository; choose one or use A0 Observe.",
			});
		}
	});
export type SaveSubscriptionInput = z.input<typeof saveSubscriptionSchema>;
export type ValidatedSubscriptionInput = z.output<
	typeof saveSubscriptionSchema
>;

/** The exact scalar columns a write binds; no secret field exists. */
export type SubscriptionWriteValues = {
	readonly connectorId: ConnectorId;
	readonly displayName: string;
	readonly eventKinds: string[];
	readonly environmentAllowlist: string[];
	readonly minSeverity: Severity;
	readonly repositoryId: string | null;
	readonly baseBranch: string | null;
	readonly autonomyLevel: AutonomyLevel;
	readonly enabled: boolean;
};

export function prepareSubscriptionWrite(
	input: ValidatedSubscriptionInput,
): SubscriptionWriteValues {
	return {
		connectorId: input.connectorId,
		displayName: input.displayName,
		eventKinds: [...new Set(input.eventKinds)],
		environmentAllowlist: [...new Set(input.environmentAllowlist)],
		minSeverity: input.minSeverity,
		repositoryId: input.repositoryId,
		baseBranch: input.baseBranch,
		autonomyLevel: input.autonomyLevel,
		enabled: input.enabled,
	};
}

export const setSubscriptionEnabledSchema = z.strictObject({
	id: z.uuid(),
	enabled: z.boolean(),
});

export const deleteSubscriptionSchema = z.strictObject({ id: z.uuid() });

/* -------------------------------------------------------------------------- */
/* Deliveries                                                                 */
/* -------------------------------------------------------------------------- */

export const signalLinkSchema = z.strictObject({
	label: z.string().min(1).max(80),
	url: z.string().min(1).max(2_000),
});
export type SignalLink = z.infer<typeof signalLinkSchema>;

export const eventDeliverySchema = z.strictObject({
	id: z.uuid(),
	connectorId: z.enum(CONNECTOR_IDS),
	source: z.string().min(1).max(32),
	eventKind: z.string().min(1).max(64),
	severity: severitySchema,
	title: z.string().max(400),
	summary: z.string().max(MAX_DELIVERY_SUMMARY_CHARS),
	status: deliveryStatusSchema,
	reasonCode: z.string().min(1).max(64).nullable(),
	repositoryName: z.string().min(1).max(200).nullable(),
	taskId: z.uuid().nullable(),
	receivedAt: z.string(),
	links: z.array(signalLinkSchema).max(MAX_SIGNAL_LINKS),
});
export type EventDelivery = z.infer<typeof eventDeliverySchema>;

export const listDeliveriesSchema = z.strictObject({
	connectorId: z.enum(CONNECTOR_IDS).optional(),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_DELIVERIES_PER_READ)
		.default(DEFAULT_DELIVERIES_PER_READ),
});
export type ListDeliveriesInput = z.output<typeof listDeliveriesSchema>;

/* -------------------------------------------------------------------------- */
/* Detail read model                                                          */
/* -------------------------------------------------------------------------- */

export const integrationDetailSchema = z.strictObject({
	summary: integrationSummarySchema,
	subscriptions: z
		.array(integrationSubscriptionSchema)
		.max(MAX_SUBSCRIPTIONS_PER_CONNECTOR),
	deliveries: z.array(eventDeliverySchema).max(MAX_DELIVERIES_PER_READ),
	/** True when the read hit its row cap, so the panel can say so. */
	deliveriesTruncated: z.boolean().default(false),
	canManage: z.boolean(),
});
export type IntegrationDetail = z.infer<typeof integrationDetailSchema>;

export const getIntegrationSchema = z.strictObject({
	connectorId: z.enum(CONNECTOR_IDS),
});

/* -------------------------------------------------------------------------- */
/* Relay and pairing                                                          */
/* -------------------------------------------------------------------------- */

export const relayViewSchema = z.strictObject({
	id: z.uuid(),
	displayName: z.string().min(1).max(100),
	status: relayStatusSchema,
	lastSeenAt: z.string().nullable(),
});
export type RelayView = z.infer<typeof relayViewSchema>;

export const pairingSessionViewSchema = z.strictObject({
	pairingId: z.uuid(),
	status: pairingStatusSchema,
	expiresAt: z.string(),
	credentialId: z.uuid().optional(),
});
export type PairingSessionView = z.infer<typeof pairingSessionViewSchema>;

export const pairingCreateViewSchema = z.strictObject({
	pairingId: z.uuid(),
	code: z.string().min(16).max(128),
	localUrl: z.string().min(1).max(512),
	expiresAt: z.string(),
});
export type PairingCreateView = z.infer<typeof pairingCreateViewSchema>;

export const pairingCancelViewSchema = z.strictObject({
	pairingId: z.uuid(),
	status: z.literal("cancelled"),
});

export const createPairingInputSchema = z.strictObject({
	relayId: z.uuid(),
	connectorId: z.enum(CONNECTOR_IDS),
	displayName: z.string().trim().min(1).max(100),
	authKind: z.enum(CONNECTOR_AUTH_KINDS),
	credentialRef: z.string().trim().min(1).max(200),
	scopes: z.array(z.string().min(1).max(64)).max(32).default([]),
});
export type CreatePairingInput = z.input<typeof createPairingInputSchema>;
export type ValidatedCreatePairingInput = z.output<
	typeof createPairingInputSchema
>;

/* -------------------------------------------------------------------------- */
/* Pure input helpers                                                         */
/* -------------------------------------------------------------------------- */

export type ListParseResult =
	| { readonly ok: true; readonly values: string[] }
	| { readonly ok: false; readonly error: string };

/** Comma- or whitespace-separated environment names, de-duplicated and capped. */
export function parseEnvironmentList(input: string): ListParseResult {
	const tokens = input
		.split(/[\s,]+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	const unique = [...new Set(tokens)];
	if (unique.length > MAX_ENVIRONMENTS) {
		return { ok: false, error: "Add at most 16 environments." };
	}
	if (unique.some((token) => !environmentSchema.safeParse(token).success)) {
		return {
			ok: false,
			error:
				"Environment names use letters, digits, dots, underscores or hyphens.",
		};
	}
	return { ok: true, values: unique };
}

export function formatEnvironmentList(values: readonly string[]): string {
	return values.join(", ");
}

/** Auth kinds display helper, re-exported so detail pages import one module. */
export type IntegrationAuthKind = ConnectorAuthKind;

export function deliveryStatusLabel(status: string): string {
	return (
		DELIVERY_STATUS_LABELS[status as DeliveryStatus] ??
		status.replaceAll("_", " ")
	);
}

export function pairingStatusLabel(status: string): string {
	return PAIRING_STATUS_LABELS[status as PairingStatus] ?? status;
}

export function autonomyLabel(level: string): string {
	return AUTONOMY_LABELS[level as StoredAutonomyLevel] ?? level;
}

/** True when the payload claims capabilities the catalog does not list. */
export function capabilitiesMatchCatalog(
	connectorId: string,
	caps: IntegrationCapabilities,
): boolean {
	const entry = integrationCatalogEntry(connectorId);
	if (entry === undefined) return false;
	return (
		entry.capabilities.eventSource === caps.eventSource &&
		entry.capabilities.context === caps.context &&
		entry.capabilities.actions === caps.actions
	);
}
