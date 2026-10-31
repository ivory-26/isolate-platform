import "@tanstack/react-start/server-only";
import { createDb, type PgSql, PostgresIncidentRepository } from "@isolate/db";
import {
	GITHUB_WEBHOOK_MIN_SECRET_LENGTH,
	GRAFANA_WEBHOOK_MIN_SECRET_LENGTH,
	PAGERDUTY_WEBHOOK_MIN_SECRET_LENGTH,
	SENTRY_WEBHOOK_MIN_SECRET_LENGTH,
} from "@isolate/integrations";
import { asOrganizationId, asUserId } from "@isolate/shared";
import { z } from "zod";
import { submitTaskSchema } from "../features/tasks/contracts";
import {
	createIncidentIntake,
	createInMemoryIncidentDedupeStore,
	type IncidentRepositoryRoute,
	type WebhookRouteBinding,
} from "./incident-intake.server";
import { GRAFANA_DEFAULT_TIMESTAMP_HEADER } from "./incident-intake-grafana.server";
import { createPostgresStore } from "./postgres-store.server";
import { createTaskService } from "./task-service.server";
import { WEBHOOK_MIN_SECRET_LENGTH } from "./webhook-signature.server";

/**
 * Composition root for the signed webhook route.
 *
 * A webhook has no browser session, so its tenant and actor come from a
 * server-side route binding (environment configuration), never from the
 * request body. The binding names exactly one organization and one repository;
 * a delivery whose service does not match is treated as unmapped.
 *
 * All identifiers are inert configuration. The only secrets are per mode and
 * server-only: `WEBHOOK_SIGNING_SECRET` (generic), `WEBHOOK_GITHUB_SECRET`
 * (`x-github-event`), `WEBHOOK_SENTRY_SECRET`, `WEBHOOK_GRAFANA_SECRET` and
 * `WEBHOOK_PAGERDUTY_SECRET`. Any secret may be configured alone (or in any
 * combination); a delivery whose detected mode has no secret is refused with
 * 503 rather than downgraded to another verifier.
 *
 * Grafana is the one mode that may run unsigned: only when the operator sets
 * `WEBHOOK_GRAFANA_ALLOW_UNSIGNED=true` explicitly. The body cap still applies
 * and a claimed signature that cannot be verified is rejected. The Grafana
 * timestamp header name is `GRAFANA_WEBHOOK_TIMESTAMP_HEADER`
 * (default `x-grafana-alerting-timestamp`) and drives both mode selection and
 * the ±300 s replay window.
 */
export class IncidentIntakeNotConfiguredError extends Error {
	constructor() {
		super("incident webhook intake is not configured");
		this.name = "IncidentIntakeNotConfiguredError";
	}
}

export const WEBHOOK_SIGNING_SECRET_VARIABLE = "WEBHOOK_SIGNING_SECRET";
export const WEBHOOK_GITHUB_SECRET_VARIABLE = "WEBHOOK_GITHUB_SECRET";
export const WEBHOOK_SENTRY_SECRET_VARIABLE = "WEBHOOK_SENTRY_SECRET";
export const WEBHOOK_GRAFANA_SECRET_VARIABLE = "WEBHOOK_GRAFANA_SECRET";
export const WEBHOOK_PAGERDUTY_SECRET_VARIABLE = "WEBHOOK_PAGERDUTY_SECRET";
/** Explicit opt-in for an unsigned Grafana contact point (deny by default). */
export const WEBHOOK_GRAFANA_ALLOW_UNSIGNED_VARIABLE =
	"WEBHOOK_GRAFANA_ALLOW_UNSIGNED";
/** Grafana timestamp header name; default `x-grafana-alerting-timestamp`. */
export const GRAFANA_WEBHOOK_TIMESTAMP_HEADER_VARIABLE =
	"GRAFANA_WEBHOOK_TIMESTAMP_HEADER";
export const WEBHOOK_ORGANIZATION_ID_VARIABLE = "WEBHOOK_ORGANIZATION_ID";
export const WEBHOOK_ACTOR_ID_VARIABLE = "WEBHOOK_ACTOR_ID";
export const WEBHOOK_ACTOR_ROLE_VARIABLE = "WEBHOOK_ACTOR_ROLE";
export const WEBHOOK_REPOSITORY_ID_VARIABLE = "WEBHOOK_REPOSITORY_ID";
export const WEBHOOK_BRANCH_VARIABLE = "WEBHOOK_BRANCH";
export const WEBHOOK_WORKFLOW_DEFINITION_ID_VARIABLE =
	"WEBHOOK_WORKFLOW_DEFINITION_ID";
export const WEBHOOK_WORKFLOW_VERSION_VARIABLE = "WEBHOOK_WORKFLOW_VERSION";
export const WEBHOOK_FILE_OWNERSHIP_VARIABLE = "WEBHOOK_FILE_OWNERSHIP";
/** Optional service filter; absent means any service routes to the repository. */
export const WEBHOOK_SERVICE_VARIABLE = "WEBHOOK_SERVICE";
/** Optional per-incident agent-turn budget; omitted keeps the submission default. */
export const WEBHOOK_MAX_AGENT_TURNS_VARIABLE = "WEBHOOK_MAX_AGENT_TURNS";

export type IncidentIntakeSettings = {
	/** Generic-mode HMAC secret; absent means generic deliveries get 503. */
	signingSecret?: string;
	/** GitHub-mode webhook secret; absent means GitHub deliveries get 503. */
	githubSecret?: string;
	/** Sentry-mode webhook secret; absent means Sentry deliveries get 503. */
	sentrySecret?: string;
	/** Grafana-mode webhook secret; absent enables unsigned only with the flag. */
	grafanaSecret?: string;
	/** PagerDuty-mode webhook secret; absent means those deliveries get 503. */
	pagerdutySecret?: string;
	/** `WEBHOOK_GRAFANA_ALLOW_UNSIGNED=true`; false by default. */
	grafanaAllowUnsigned: boolean;
	/** Configured Grafana timestamp header; also drives mode selection. */
	grafanaTimestampHeader: string;
	binding: WebhookRouteBinding;
	repositoryId: string;
	branch: string;
	workflowDefinitionId: string;
	workflowVersion: number;
	fileOwnership: readonly string[];
	service?: string;
	/** Bounds how long an incident task may loop before the diff gate decides. */
	maxAgentTurns?: number;
};

const GRAFANA_HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const settingsSchema = z.strictObject({
	signingSecret: z.string().min(WEBHOOK_MIN_SECRET_LENGTH).optional(),
	githubSecret: z.string().min(GITHUB_WEBHOOK_MIN_SECRET_LENGTH).optional(),
	sentrySecret: z.string().min(SENTRY_WEBHOOK_MIN_SECRET_LENGTH).optional(),
	grafanaSecret: z.string().min(GRAFANA_WEBHOOK_MIN_SECRET_LENGTH).optional(),
	pagerdutySecret: z
		.string()
		.min(PAGERDUTY_WEBHOOK_MIN_SECRET_LENGTH)
		.optional(),
	grafanaAllowUnsigned: z.boolean(),
	grafanaTimestampHeader: z
		.string()
		.trim()
		.regex(GRAFANA_HEADER_NAME_PATTERN, "invalid header name"),
	organizationId: z.uuid(),
	actorId: z.uuid(),
	actorRole: z.enum(["owner", "admin", "member"]).default("member"),
	repositoryId: z.uuid(),
	branch: submitTaskSchema.shape.branch,
	workflowDefinitionId: z.uuid(),
	workflowVersion: z.number().int().min(1).max(2147483647),
	fileOwnership: submitTaskSchema.shape.fileOwnership,
	service: z.string().trim().min(1).max(128).optional(),
	maxAgentTurns: z.number().int().min(1).max(50).optional(),
});

function fileOwnershipFrom(env: Record<string, string | undefined>): string[] {
	const raw = env[WEBHOOK_FILE_OWNERSHIP_VARIABLE];
	if (raw === undefined) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * An empty or whitespace secret is "not configured", not a zero-length key:
 * CI passes unset variables as empty strings. Each mode then fails closed on
 * its own instead of disabling the other mode's secret.
 */
function secretFrom(
	env: Record<string, string | undefined>,
	name: string,
): string | undefined {
	const value = env[name];
	return value === undefined || value.trim().length === 0 ? undefined : value;
}

/**
 * The explicit unsigned-Grafana opt-in. Only the literal `true` (trimmed,
 * case-insensitive) enables it; any other value — including a typo — stays
 * deny-by-default.
 */
function allowUnsignedFrom(env: Record<string, string | undefined>): boolean {
	return (
		env[WEBHOOK_GRAFANA_ALLOW_UNSIGNED_VARIABLE]?.trim().toLowerCase() ===
		"true"
	);
}

/** Configured timestamp header name, or the documented default. */
function grafanaTimestampHeaderFrom(
	env: Record<string, string | undefined>,
): string {
	const raw = secretFrom(env, GRAFANA_WEBHOOK_TIMESTAMP_HEADER_VARIABLE);
	return raw === undefined ? GRAFANA_DEFAULT_TIMESTAMP_HEADER : raw.trim();
}

/** Returns null when any required binding value is absent or invalid. */
export function readIncidentIntakeSettings(
	env: Record<string, string | undefined>,
): IncidentIntakeSettings | null {
	const signingSecret = secretFrom(env, WEBHOOK_SIGNING_SECRET_VARIABLE);
	const githubSecret = secretFrom(env, WEBHOOK_GITHUB_SECRET_VARIABLE);
	const sentrySecret = secretFrom(env, WEBHOOK_SENTRY_SECRET_VARIABLE);
	const grafanaSecret = secretFrom(env, WEBHOOK_GRAFANA_SECRET_VARIABLE);
	const pagerdutySecret = secretFrom(env, WEBHOOK_PAGERDUTY_SECRET_VARIABLE);
	const parsed = settingsSchema.safeParse({
		...(signingSecret === undefined ? {} : { signingSecret }),
		...(githubSecret === undefined ? {} : { githubSecret }),
		...(sentrySecret === undefined ? {} : { sentrySecret }),
		...(grafanaSecret === undefined ? {} : { grafanaSecret }),
		...(pagerdutySecret === undefined ? {} : { pagerdutySecret }),
		grafanaAllowUnsigned: allowUnsignedFrom(env),
		grafanaTimestampHeader: grafanaTimestampHeaderFrom(env),
		organizationId: env[WEBHOOK_ORGANIZATION_ID_VARIABLE],
		actorId: env[WEBHOOK_ACTOR_ID_VARIABLE],
		actorRole: env[WEBHOOK_ACTOR_ROLE_VARIABLE] ?? "member",
		repositoryId: env[WEBHOOK_REPOSITORY_ID_VARIABLE],
		branch: env[WEBHOOK_BRANCH_VARIABLE],
		workflowDefinitionId: env[WEBHOOK_WORKFLOW_DEFINITION_ID_VARIABLE],
		workflowVersion:
			env[WEBHOOK_WORKFLOW_VERSION_VARIABLE] === undefined
				? undefined
				: Number(env[WEBHOOK_WORKFLOW_VERSION_VARIABLE]),
		fileOwnership: fileOwnershipFrom(env),
		...(env[WEBHOOK_SERVICE_VARIABLE] === undefined
			? {}
			: { service: env[WEBHOOK_SERVICE_VARIABLE] }),
		maxAgentTurns:
			env[WEBHOOK_MAX_AGENT_TURNS_VARIABLE] === undefined
				? undefined
				: Number(env[WEBHOOK_MAX_AGENT_TURNS_VARIABLE]),
	});
	if (!parsed.success) return null;
	const service = parsed.data.service;
	return {
		...(parsed.data.signingSecret === undefined
			? {}
			: { signingSecret: parsed.data.signingSecret }),
		...(parsed.data.githubSecret === undefined
			? {}
			: { githubSecret: parsed.data.githubSecret }),
		...(parsed.data.sentrySecret === undefined
			? {}
			: { sentrySecret: parsed.data.sentrySecret }),
		...(parsed.data.grafanaSecret === undefined
			? {}
			: { grafanaSecret: parsed.data.grafanaSecret }),
		...(parsed.data.pagerdutySecret === undefined
			? {}
			: { pagerdutySecret: parsed.data.pagerdutySecret }),
		grafanaAllowUnsigned: parsed.data.grafanaAllowUnsigned,
		grafanaTimestampHeader: parsed.data.grafanaTimestampHeader,
		binding: {
			organizationId: asOrganizationId(
				parsed.data.organizationId.toLowerCase(),
			),
			userId: asUserId(parsed.data.actorId.toLowerCase()),
			role: parsed.data.actorRole,
		},
		repositoryId: parsed.data.repositoryId.toLowerCase(),
		branch: parsed.data.branch,
		workflowDefinitionId: parsed.data.workflowDefinitionId.toLowerCase(),
		workflowVersion: parsed.data.workflowVersion,
		fileOwnership: parsed.data.fileOwnership,
		...(service === undefined ? {} : { service }),
		...(parsed.data.maxAgentTurns === undefined
			? {}
			: { maxAgentTurns: parsed.data.maxAgentTurns }),
	};
}

let sql: PgSql | undefined;
let sqlUrl: string | undefined;
let store: ReturnType<typeof createPostgresStore> | undefined;
let incidentRepository: PostgresIncidentRepository | undefined;
let intake: ReturnType<typeof createIncidentIntake> | undefined;
/**
 * Process-local dedupe for the single-process deployment. A multi-instance
 * deployment must inject a SQL-backed store; the intake interface is the seam.
 */
const dedupe = createInMemoryIncidentDedupeStore();

type PostgresBundle = {
	store: ReturnType<typeof createPostgresStore>;
	incidentRepository: PostgresIncidentRepository;
};

function getStore(databaseUrl: string): PostgresBundle {
	if (
		store !== undefined &&
		incidentRepository !== undefined &&
		sqlUrl === databaseUrl
	)
		return { store, incidentRepository };
	sql = createDb(databaseUrl);
	sqlUrl = databaseUrl;
	store = createPostgresStore(sql);
	// Signal dedupe and the per-org incident cap share the same connection pool.
	incidentRepository = new PostgresIncidentRepository(sql);
	return { store, incidentRepository };
}

export function incidentRepositoryRoute(
	settings: IncidentIntakeSettings,
	input: { organizationId: string; service: string },
): IncidentRepositoryRoute | null {
	if (input.organizationId !== settings.binding.organizationId) return null;
	if (settings.service !== undefined && input.service !== settings.service)
		return null;
	return {
		organizationId: settings.binding.organizationId,
		repositoryId: settings.repositoryId,
		branch: settings.branch,
		workflowDefinitionId: settings.workflowDefinitionId,
		workflowVersion: settings.workflowVersion,
		fileOwnership: settings.fileOwnership,
		...(settings.maxAgentTurns === undefined
			? {}
			: { budget: { maxAgentTurns: settings.maxAgentTurns } }),
	};
}

/**
 * At least one mode must be usable: any per-mode secret, or the explicit
 * unsigned-Grafana opt-in (which needs no secret).
 */
export function hasConfiguredIntakeMode(
	settings: IncidentIntakeSettings,
): boolean {
	return (
		settings.signingSecret !== undefined ||
		settings.githubSecret !== undefined ||
		settings.sentrySecret !== undefined ||
		settings.grafanaSecret !== undefined ||
		settings.pagerdutySecret !== undefined ||
		settings.grafanaAllowUnsigned
	);
}

/**
 * Builds (once) the intake used by the route. Missing configuration fails
 * closed; the route maps that to 503 without detail. At least one mode must be
 * usable: any secret, or the explicit unsigned-Grafana opt-in.
 */
export function getIncidentIntake(
	env: Record<string, string | undefined> = process.env,
): ReturnType<typeof createIncidentIntake> {
	if (intake !== undefined) return intake;
	const settings = readIncidentIntakeSettings(env);
	const databaseUrl = env.DATABASE_URL;
	if (settings === null) throw new IncidentIntakeNotConfiguredError();
	if (
		!hasConfiguredIntakeMode(settings) ||
		databaseUrl === undefined ||
		databaseUrl.length === 0
	)
		throw new IncidentIntakeNotConfiguredError();
	const { store: taskStore, incidentRepository: signals } =
		getStore(databaseUrl);
	const service = createTaskService({
		// The verified route binding is the caller identity for this path.
		resolveScope: async () => settings.binding,
		getStore: async () => taskStore,
	});
	intake = createIncidentIntake({
		// Explicit null means "this mode is not configured"; a missing secret is
		// refused per mode rather than silently downgraded to another verifier.
		signingSecret: settings.signingSecret ?? null,
		githubSecret: settings.githubSecret ?? null,
		sentrySecret: settings.sentrySecret ?? null,
		grafanaSecret: settings.grafanaSecret ?? null,
		pagerdutySecret: settings.pagerdutySecret ?? null,
		grafanaAllowUnsigned: settings.grafanaAllowUnsigned,
		grafanaTimestampHeader: settings.grafanaTimestampHeader,
		binding: settings.binding,
		resolveRepository: async (input) =>
			incidentRepositoryRoute(settings, input),
		incidentRepository: signals,
		dedupe,
		submitTask: (input) => service.submit(input),
	});
	return intake;
}
