import type { SetupState } from "./contracts";

/**
 * Pure wizard model. The route renders these steps; tests assert the order,
 * the completeness rules and the relay command formatting without a DOM.
 */

export type SetupStepId = "github" | "relay" | "source" | "autonomy";

export type SetupStep = {
	readonly id: SetupStepId;
	readonly title: string;
	readonly description: string;
	readonly complete: boolean;
	readonly actionLabel: string;
};

export const SETUP_STEP_ORDER: readonly SetupStepId[] = [
	"github",
	"relay",
	"source",
	"autonomy",
];

export function buildSetupSteps(state: SetupState): SetupStep[] {
	return [
		{
			id: "github",
			title: "Connect GitHub",
			description:
				"Install the Isolate GitHub App, then import the repositories Isolate may work on.",
			complete: state.githubConnected && state.hasRepository,
			actionLabel:
				state.githubConnected && state.hasRepository
					? "GitHub ready"
					: state.githubConnected
						? "Import repositories"
						: "Install GitHub App",
		},
		{
			id: "relay",
			title: "Install a relay",
			description:
				"Register a relay once, run the install command on your machine, and wait for its first heartbeat.",
			complete: state.relayActive,
			actionLabel: state.relayActive ? "Relay active" : "Register relay",
		},
		{
			id: "source",
			title: "Connect a source",
			description:
				"Choose a connector, then enter its credential on the relay's loopback page. Isolate stores metadata only.",
			complete: state.connectionActive,
			actionLabel: state.connectionActive
				? "Source connected"
				: "Browse catalog",
		},
		{
			id: "autonomy",
			title: "Set autonomy",
			description:
				"Create the default production critical/high rule at A2 and map it to an imported repository.",
			complete: state.triggerEnabled,
			actionLabel: state.triggerEnabled ? "Trigger enabled" : "Create trigger",
		},
	];
}

/** The first incomplete step, or null when every step is done. */
export function currentSetupStep(state: SetupState): SetupStepId | null {
	const step = buildSetupSteps(state).find((entry) => !entry.complete);
	return step?.id ?? null;
}

export function completedStepCount(state: SetupState): number {
	return buildSetupSteps(state).filter((step) => step.complete).length;
}

/**
 * One-line relay install command. Values are shell-quoted so a display name
 * cannot break out of the command; the token pattern is the daemon's opaque
 * token shape. Returns null when the input is not safe to show.
 */
export function buildRelayInstallCommand(input: {
	readonly serverUrl: string;
	readonly token: string;
	readonly name: string;
}): string | null {
	const serverUrl = normalizeServerUrl(input.serverUrl);
	if (serverUrl === null) return null;
	const token = input.token.trim();
	if (!/^[A-Za-z0-9._~-]{16,512}$/.test(token)) return null;
	const name = input.name.trim().slice(0, 100);
	if (name.length === 0) return null;
	return `curl -fsSL ${shellQuote(`${serverUrl}/install/relay.sh`)} | sh -s -- --server ${shellQuote(serverUrl)} --token ${shellQuote(token)} --name ${shellQuote(name)}`;
}

function normalizeServerUrl(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username.length > 0 || url.password.length > 0) return null;
	if (url.search.length > 0 || url.hash.length > 0) return null;
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9._~:/@%+=,-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
