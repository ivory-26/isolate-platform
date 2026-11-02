import "@tanstack/react-start/server-only";
import {
	deriveSetupState,
	type SetupState,
	type SetupStateRow,
} from "./contracts";

/**
 * Tenant-scoped setup derivation.
 *
 * One bounded statement answers every checklist question with EXISTS subqueries
 * scoped by `organization_id` as `$1`. No provider payload, repository name or
 * identifier other than the active connector id leaves this module.
 */
export const SETUP_STATE_SQL = `SELECT
	EXISTS (
		SELECT 1 FROM github_installations
		WHERE organization_id = $1 AND status = 'active'
	) AS github_connected,
	EXISTS (
		SELECT 1 FROM connector_devices
		WHERE organization_id = $1 AND status = 'active'
	) AS relay_active,
	EXISTS (
		SELECT 1 FROM connector_credentials
		WHERE organization_id = $1 AND status = 'active'
	) AS connection_active,
	EXISTS (
		SELECT 1 FROM integration_subscriptions
		WHERE organization_id = $1 AND enabled
	) AS trigger_enabled,
	EXISTS (
		SELECT 1 FROM tasks WHERE organization_id = $1
	) AS first_run,
	EXISTS (
		SELECT 1 FROM repositories WHERE organization_id = $1
	) AS has_repository,
	EXISTS (
		SELECT 1 FROM connector_devices WHERE organization_id = $1
	) AS has_relay,
	EXISTS (
		SELECT 1 FROM connector_credentials
		WHERE organization_id = $1 AND status <> 'revoked'
	) AS has_connection,
	(
		SELECT connector_id FROM connector_credentials
		WHERE organization_id = $1 AND status = 'active'
		ORDER BY created_at ASC, id ASC
		LIMIT 1
	) AS active_connector_id`;

export type OnboardingReadSql = {
	unsafe(query: string, parameters?: readonly unknown[]): Promise<unknown>;
};

export async function readSetupState(
	sql: OnboardingReadSql,
	organizationId: string,
): Promise<SetupState> {
	const result = await sql.unsafe(SETUP_STATE_SQL, [organizationId]);
	if (!Array.isArray(result) || result.length === 0) {
		throw new Error("setup read returned no row");
	}
	return deriveSetupState(result[0] as SetupStateRow);
}

export type { SetupState };
