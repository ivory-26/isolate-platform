import { hasCapability, type UserRole } from "@isolate/db";
import { createServerFn } from "@tanstack/react-start";
import { uiRead } from "../../server/ui-runtime.server";
import {
	UiInvalidInputError,
	UiNotFoundError,
	type UiResult,
} from "../ui/contracts";
import { CONNECTOR_CAPABILITY, platformCapabilityFor } from "./capabilities";
import { INTEGRATION_CATALOG, integrationCatalogEntry } from "./catalog";
import {
	DEFAULT_DELIVERIES_PER_READ,
	deleteSubscriptionSchema,
	type EventDelivery,
	getIntegrationSchema,
	type IntegrationDetail,
	type IntegrationSubscription,
	type IntegrationSummary,
	listDeliveriesSchema,
	prepareSubscriptionWrite,
	saveSubscriptionSchema,
	setSubscriptionEnabledSchema,
} from "./contracts";
import {
	readDeliveries,
	readIntegrations,
	readSubscriptions,
	summarizeIntegration,
} from "./integrations-read.server";

/**
 * Tenant-scoped integration surfaces.
 *
 * Reads are gated by the connector read capability; writes by the manage
 * capability. Every handler sets `private, no-store` through `uiRead`, binds
 * `organization_id` in SQL and returns a bounded `UiResult`. The browser never
 * receives a provider payload, secret or token.
 */

function canManage(role: UserRole): boolean {
	return hasCapability(
		role,
		platformCapabilityFor(CONNECTOR_CAPABILITY.manage),
	);
}

export const listIntegrations = createServerFn({ method: "GET" }).handler(
	async (): Promise<
		UiResult<{ integrations: IntegrationSummary[]; canManage: boolean }>
	> =>
		uiRead(
			platformCapabilityFor(CONNECTOR_CAPABILITY.read),
			async (scope, sql) => {
				const aggregate = await readIntegrations(sql, scope.organizationId);
				return {
					integrations: INTEGRATION_CATALOG.map((entry) =>
						summarizeIntegration(entry, aggregate),
					),
					canManage: canManage(scope.role),
				};
			},
		),
);

export const getIntegration = createServerFn({ method: "GET" })
	.validator((input: unknown) => {
		const parsed = getIntegrationSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid integration request.");
		return parsed.data;
	})
	.handler(
		async ({ data }): Promise<UiResult<IntegrationDetail>> =>
			uiRead(
				platformCapabilityFor(CONNECTOR_CAPABILITY.read),
				async (scope, sql) => {
					const entry = integrationCatalogEntry(data.connectorId);
					if (entry === undefined) throw new UiNotFoundError();
					const aggregate = await readIntegrations(sql, scope.organizationId);
					const subscriptions = await readSubscriptions(
						sql,
						scope.organizationId,
						data.connectorId,
					);
					const deliveries = await readDeliveries(sql, scope.organizationId, {
						connectorId: data.connectorId,
						limit: DEFAULT_DELIVERIES_PER_READ,
					});
					return {
						summary: summarizeIntegration(entry, aggregate),
						subscriptions: subscriptions.subscriptions,
						deliveries: deliveries.deliveries,
						canManage: canManage(scope.role),
					};
				},
			),
	);

export const listDeliveries = createServerFn({ method: "GET" })
	.validator((input: unknown) => {
		const parsed = listDeliveriesSchema.safeParse(input ?? {});
		if (!parsed.success) throw new Error("Invalid delivery request.");
		return parsed.data;
	})
	.handler(
		async ({ data }): Promise<UiResult<{ deliveries: EventDelivery[] }>> =>
			uiRead(
				platformCapabilityFor(CONNECTOR_CAPABILITY.read),
				async (scope, sql) => {
					const result = await readDeliveries(sql, scope.organizationId, {
						...(data.connectorId === undefined
							? {}
							: { connectorId: data.connectorId }),
						limit: data.limit,
					});
					return { deliveries: result.deliveries };
				},
			),
	);

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

const REPOSITORY_EXISTS_SQL = `SELECT id FROM repositories
WHERE organization_id = $1 AND id = $2
LIMIT 1`;

const SUBSCRIPTION_NAME_SQL = `SELECT id FROM integration_subscriptions
WHERE organization_id = $1 AND connector_id = $2 AND display_name = $3
LIMIT 1`;

const INSERT_SUBSCRIPTION_SQL = `INSERT INTO integration_subscriptions (
	organization_id, connector_id, display_name, event_kinds,
	environment_allowlist, min_severity, repository_id, base_branch,
	autonomy_level, enabled, created_by
) VALUES (
	$1, $2, $3, $4::text[], $5::text[], $6, $7, $8, $9, $10, $11
)
RETURNING id`;

const UPDATE_SUBSCRIPTION_SQL = `UPDATE integration_subscriptions SET
	display_name = $3,
	event_kinds = $4::text[],
	environment_allowlist = $5::text[],
	min_severity = $6,
	repository_id = $7,
	base_branch = $8,
	autonomy_level = $9,
	enabled = $10,
	updated_at = now()
WHERE organization_id = $1 AND id = $2
RETURNING id`;

const SET_ENABLED_SQL = `UPDATE integration_subscriptions SET
	enabled = $3, updated_at = now()
WHERE organization_id = $1 AND id = $2
RETURNING id, connector_id`;

const DELETE_SUBSCRIPTION_SQL = `DELETE FROM integration_subscriptions
WHERE organization_id = $1 AND id = $2
RETURNING id`;

function rowsOf(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) {
		throw new Error("integration write returned an unexpected row shape");
	}
	return value as Record<string, unknown>[];
}

async function readSubscriptionById(
	sql: Parameters<typeof readSubscriptions>[0],
	organizationId: string,
	connectorId: string,
	id: string,
): Promise<IntegrationSubscription> {
	const result = await readSubscriptions(sql, organizationId, connectorId);
	const subscription = result.subscriptions.find((row) => row.id === id);
	if (subscription === undefined) throw new UiNotFoundError();
	return subscription;
}

export const saveSubscription = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = saveSubscriptionSchema.safeParse(input);
		if (!parsed.success) {
			throw new UiInvalidInputError("Invalid trigger rule.");
		}
		return parsed.data;
	})
	.handler(
		async ({
			data,
		}): Promise<UiResult<{ subscription: IntegrationSubscription }>> =>
			uiRead(
				platformCapabilityFor(CONNECTOR_CAPABILITY.manage),
				async (scope, sql) => {
					const values = prepareSubscriptionWrite(data);
					if (values.repositoryId !== null) {
						const repository = rowsOf(
							await sql.unsafe(REPOSITORY_EXISTS_SQL, [
								scope.organizationId,
								values.repositoryId,
							]),
						);
						if (repository.length === 0) {
							throw new UiInvalidInputError("Unknown repository.");
						}
					}
					if (data.id !== undefined) {
						const updated = rowsOf(
							await sql.unsafe(UPDATE_SUBSCRIPTION_SQL, [
								scope.organizationId,
								data.id,
								values.displayName,
								values.eventKinds,
								values.environmentAllowlist,
								values.minSeverity,
								values.repositoryId,
								values.baseBranch,
								values.autonomyLevel,
								values.enabled,
							]),
						);
						if (updated.length === 0) throw new UiNotFoundError();
						return {
							subscription: await readSubscriptionById(
								sql,
								scope.organizationId,
								values.connectorId,
								data.id,
							),
						};
					}
					const duplicate = rowsOf(
						await sql.unsafe(SUBSCRIPTION_NAME_SQL, [
							scope.organizationId,
							values.connectorId,
							values.displayName,
						]),
					);
					if (duplicate.length > 0) {
						throw new UiInvalidInputError("Duplicate trigger name.");
					}
					const inserted = rowsOf(
						await sql.unsafe(INSERT_SUBSCRIPTION_SQL, [
							scope.organizationId,
							values.connectorId,
							values.displayName,
							values.eventKinds,
							values.environmentAllowlist,
							values.minSeverity,
							values.repositoryId,
							values.baseBranch,
							values.autonomyLevel,
							values.enabled,
							scope.userId,
						]),
					);
					const id = inserted[0]?.id;
					if (typeof id !== "string") throw new UiInvalidInputError();
					return {
						subscription: await readSubscriptionById(
							sql,
							scope.organizationId,
							values.connectorId,
							id,
						),
					};
				},
			),
	);

export const setSubscriptionEnabled = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = setSubscriptionEnabledSchema.safeParse(input);
		if (!parsed.success) throw new UiInvalidInputError("Invalid toggle.");
		return parsed.data;
	})
	.handler(
		async ({
			data,
		}): Promise<UiResult<{ subscription: IntegrationSubscription }>> =>
			uiRead(
				platformCapabilityFor(CONNECTOR_CAPABILITY.manage),
				async (scope, sql) => {
					const rows = rowsOf(
						await sql.unsafe(SET_ENABLED_SQL, [
							scope.organizationId,
							data.id,
							data.enabled,
						]),
					);
					if (rows.length === 0) throw new UiNotFoundError();
					const connectorId = rows[0]?.connector_id;
					const subscription = await readSubscriptionById(
						sql,
						scope.organizationId,
						typeof connectorId === "string" ? connectorId : "",
						data.id,
					);
					return { subscription };
				},
			),
	);

export const deleteSubscription = createServerFn({ method: "POST" })
	.validator((input: unknown) => {
		const parsed = deleteSubscriptionSchema.safeParse(input);
		if (!parsed.success) throw new UiInvalidInputError("Invalid delete.");
		return parsed.data;
	})
	.handler(
		async ({ data }): Promise<UiResult<{ status: "deleted" }>> =>
			uiRead(
				platformCapabilityFor(CONNECTOR_CAPABILITY.manage),
				async (scope, sql) => {
					const rows = rowsOf(
						await sql.unsafe(DELETE_SUBSCRIPTION_SQL, [
							scope.organizationId,
							data.id,
						]),
					);
					if (rows.length === 0) throw new UiNotFoundError();
					return { status: "deleted" as const };
				},
			),
	);
