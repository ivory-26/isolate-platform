import { z } from "zod";
import { CONNECTOR_IDS } from "../devices/contracts";

/**
 * Client-safe setup state for the onboarding wizard and the Home checklist.
 *
 * The six documented flags drive the wizard. The four extra flags exist only to
 * gate the first-sign-in redirect honestly: an existing workspace with a
 * repository, a relay, a connection or a task is never forced through setup.
 */
export const setupStateSchema = z.strictObject({
	githubConnected: z.boolean(),
	relayActive: z.boolean(),
	connectionActive: z.boolean(),
	triggerEnabled: z.boolean(),
	firstRun: z.boolean(),
	complete: z.boolean(),
	hasRepository: z.boolean(),
	hasRelay: z.boolean(),
	hasConnection: z.boolean(),
	activeConnectorId: z.enum(CONNECTOR_IDS).nullable(),
});
export type SetupState = z.infer<typeof setupStateSchema>;

export type SetupStateRow = {
	readonly github_connected?: unknown;
	readonly relay_active?: unknown;
	readonly connection_active?: unknown;
	readonly trigger_enabled?: unknown;
	readonly first_run?: unknown;
	readonly has_repository?: unknown;
	readonly has_relay?: unknown;
	readonly has_connection?: unknown;
	readonly active_connector_id?: unknown;
};

function truthy(value: unknown): boolean {
	return value === true || value === "t" || value === "true";
}

function connectorValue(value: unknown): SetupState["activeConnectorId"] {
	if (typeof value !== "string") return null;
	return (CONNECTOR_IDS as readonly string[]).includes(value)
		? (value as SetupState["activeConnectorId"])
		: null;
}

/** Pure row mapping; exported so the derivation tests need no database. */
export function deriveSetupState(row: SetupStateRow): SetupState {
	const githubConnected = truthy(row.github_connected);
	const relayActive = truthy(row.relay_active);
	const connectionActive = truthy(row.connection_active);
	const triggerEnabled = truthy(row.trigger_enabled);
	return {
		githubConnected,
		relayActive,
		connectionActive,
		triggerEnabled,
		firstRun: truthy(row.first_run),
		complete:
			githubConnected && relayActive && connectionActive && triggerEnabled,
		hasRepository: truthy(row.has_repository),
		hasRelay: truthy(row.has_relay),
		hasConnection: truthy(row.has_connection),
		activeConnectorId: connectorValue(row.active_connector_id),
	};
}

export const EMPTY_SETUP_STATE: SetupState = {
	githubConnected: false,
	relayActive: false,
	connectionActive: false,
	triggerEnabled: false,
	firstRun: false,
	complete: false,
	hasRepository: false,
	hasRelay: false,
	hasConnection: false,
	activeConnectorId: null,
};

/**
 * The only condition under which `_app` sends a caller to `/onboarding`:
 * setup is incomplete and the organization has never made a first step in any
 * surface. An existing populated workspace is never redirected.
 */
export function shouldStartOnboarding(state: SetupState): boolean {
	return (
		!state.complete &&
		!state.hasRepository &&
		!state.hasRelay &&
		!state.hasConnection &&
		!state.firstRun
	);
}
