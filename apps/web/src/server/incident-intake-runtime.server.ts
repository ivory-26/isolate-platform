import "@tanstack/react-start/server-only";
import { createDb, type PgSql } from "@isolate/db";
import { asOrganizationId, asUserId } from "@isolate/shared";
import { z } from "zod";
import { submitTaskSchema } from "../features/tasks/contracts";
import {
	createIncidentIntake,
	createInMemoryIncidentDedupeStore,
	type IncidentRepositoryRoute,
	type WebhookRouteBinding,
} from "./incident-intake.server";
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
 * All identifiers are inert configuration. The only secret is
 * `WEBHOOK_SIGNING_SECRET`, and it never leaves this process.
 */
export class IncidentIntakeNotConfiguredError extends Error {
	constructor() {
		super("incident webhook intake is not configured");
		this.name = "IncidentIntakeNotConfiguredError";
	}
}

export const WEBHOOK_SIGNING_SECRET_VARIABLE = "WEBHOOK_SIGNING_SECRET";
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

export type IncidentIntakeSettings = {
	signingSecret: string;
	binding: WebhookRouteBinding;
	repositoryId: string;
	branch: string;
	workflowDefinitionId: string;
	workflowVersion: number;
	fileOwnership: readonly string[];
	service?: string;
};

const settingsSchema = z.strictObject({
	signingSecret: z.string().min(WEBHOOK_MIN_SECRET_LENGTH),
	organizationId: z.uuid(),
	actorId: z.uuid(),
	actorRole: z.enum(["owner", "admin", "member"]).default("member"),
	repositoryId: z.uuid(),
	branch: submitTaskSchema.shape.branch,
	workflowDefinitionId: z.uuid(),
	workflowVersion: z.number().int().min(1).max(2147483647),
	fileOwnership: submitTaskSchema.shape.fileOwnership,
	service: z.string().trim().min(1).max(128).optional(),
});

function fileOwnershipFrom(env: Record<string, string | undefined>): string[] {
	const raw = env[WEBHOOK_FILE_OWNERSHIP_VARIABLE];
	if (raw === undefined) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Returns null when any required binding value is absent or invalid. */
export function readIncidentIntakeSettings(
	env: Record<string, string | undefined>,
): IncidentIntakeSettings | null {
	const parsed = settingsSchema.safeParse({
		signingSecret: env[WEBHOOK_SIGNING_SECRET_VARIABLE],
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
	});
	if (!parsed.success) return null;
	const service = parsed.data.service;
	return {
		signingSecret: parsed.data.signingSecret,
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
	};
}

let sql: PgSql | undefined;
let sqlUrl: string | undefined;
let store: ReturnType<typeof createPostgresStore> | undefined;
let intake: ReturnType<typeof createIncidentIntake> | undefined;
/**
 * Process-local dedupe for the single-process deployment. A multi-instance
 * deployment must inject a SQL-backed store; the intake interface is the seam.
 */
const dedupe = createInMemoryIncidentDedupeStore();

function getStore(databaseUrl: string): ReturnType<typeof createPostgresStore> {
	if (store !== undefined && sqlUrl === databaseUrl) return store;
	sql = createDb(databaseUrl);
	sqlUrl = databaseUrl;
	store = createPostgresStore(sql);
	return store;
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
	};
}

/**
 * Builds (once) the intake used by the route. Missing configuration fails
 * closed; the route maps that to 503 without detail.
 */
export function getIncidentIntake(
	env: Record<string, string | undefined> = process.env,
): ReturnType<typeof createIncidentIntake> {
	if (intake !== undefined) return intake;
	const settings = readIncidentIntakeSettings(env);
	const databaseUrl = env.DATABASE_URL;
	if (
		settings === null ||
		databaseUrl === undefined ||
		databaseUrl.length === 0
	)
		throw new IncidentIntakeNotConfiguredError();
	const taskStore = getStore(databaseUrl);
	const service = createTaskService({
		// The verified route binding is the caller identity for this path.
		resolveScope: async () => settings.binding,
		getStore: async () => taskStore,
	});
	intake = createIncidentIntake({
		signingSecret: settings.signingSecret,
		binding: settings.binding,
		resolveRepository: async (input) =>
			incidentRepositoryRoute(settings, input),
		dedupe,
		submitTask: (input) => service.submit(input),
	});
	return intake;
}
