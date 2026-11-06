import { describe, expect, test } from "bun:test";
import {
	deriveSetupState,
	EMPTY_SETUP_STATE,
	type SetupState,
	shouldStartOnboarding,
} from "./contracts";
import { readSetupState, SETUP_STATE_SQL } from "./onboarding-read.server";
import {
	buildRelayInstallCommand,
	buildSetupSteps,
	completedStepCount,
	currentSetupStep,
	SETUP_STEP_ORDER,
} from "./setup-steps";

const ORG = "11111111-1111-4111-8111-111111111111";

function state(overrides: Partial<SetupState> = {}): SetupState {
	return { ...EMPTY_SETUP_STATE, ...overrides };
}

describe("deriveSetupState", () => {
	test("maps an empty organization to the empty state", () => {
		expect(deriveSetupState({})).toEqual(EMPTY_SETUP_STATE);
	});

	test("derives completion from all four steps", () => {
		const derived = deriveSetupState({
			github_connected: "t",
			relay_active: true,
			connection_active: true,
			trigger_enabled: true,
			first_run: "true",
			has_repository: true,
			has_relay: true,
			has_connection: true,
			active_connector_id: "sentry",
		});
		expect(derived).toEqual({
			githubConnected: true,
			relayActive: true,
			connectionActive: true,
			triggerEnabled: true,
			firstRun: true,
			complete: true,
			hasRepository: true,
			hasRelay: true,
			hasConnection: true,
			activeConnectorId: "sentry",
		});
	});

	test("is incomplete when any step is missing", () => {
		const derived = deriveSetupState({
			github_connected: true,
			relay_active: true,
			connection_active: true,
			trigger_enabled: false,
		});
		expect(derived.complete).toBe(false);
	});

	test("drops an unknown active connector id", () => {
		expect(
			deriveSetupState({ active_connector_id: "jenkins" }).activeConnectorId,
		).toBeNull();
		expect(
			deriveSetupState({ active_connector_id: 42 }).activeConnectorId,
		).toBeNull();
	});
});

describe("shouldStartOnboarding", () => {
	test("sends only a completely empty workspace to setup", () => {
		expect(shouldStartOnboarding(EMPTY_SETUP_STATE)).toBe(true);
	});

	test("never redirects a workspace that already has any surface", () => {
		for (const partial of [
			{ githubConnected: true },
			{ hasRepository: true },
			{ hasRelay: true },
			{ hasConnection: true },
			{ firstRun: true },
			{ complete: true },
		]) {
			expect(shouldStartOnboarding(state(partial))).toBe(false);
		}
	});
});

describe("setup steps", () => {
	test("keeps the four-step order and reports the first incomplete step", () => {
		const steps = buildSetupSteps(EMPTY_SETUP_STATE);
		expect(steps.map((step) => step.id)).toEqual([...SETUP_STEP_ORDER]);
		expect(currentSetupStep(EMPTY_SETUP_STATE)).toBe("github");
		expect(completedStepCount(EMPTY_SETUP_STATE)).toBe(0);
	});

	test("advances as state becomes true", () => {
		const partial = state({ githubConnected: true, hasRepository: true });
		expect(currentSetupStep(partial)).toBe("relay");
		expect(completedStepCount(partial)).toBe(1);

		const complete = state({
			githubConnected: true,
			hasRepository: true,
			relayActive: true,
			connectionActive: true,
			triggerEnabled: true,
		});
		expect(currentSetupStep(complete)).toBeNull();
		expect(completedStepCount(complete)).toBe(4);
	});
});

describe("buildRelayInstallCommand", () => {
	const token = "abcdefghijklmnopqrstuvwx1234567890";

	test("builds one copyable command with the server and token", () => {
		expect(
			buildRelayInstallCommand({
				serverUrl: "https://isolate.example.com/",
				token,
				name: "sre-laptop",
			}),
		).toBe(
			`curl -fsSL https://isolate.example.com/api/install/relay | sh -s -- --server https://isolate.example.com --token ${token} --name sre-laptop`,
		);
	});

	test("shell-quotes a display name with spaces", () => {
		const command = buildRelayInstallCommand({
			serverUrl: "https://isolate.example.com",
			token,
			name: "prod vm",
		});
		expect(command).toContain("--name 'prod vm'");
	});

	test("quotes an embedded single quote instead of breaking the command", () => {
		const command = buildRelayInstallCommand({
			serverUrl: "https://isolate.example.com",
			token,
			name: "bad'name",
		});
		expect(command).toContain(String.raw`--name 'bad'\''name'`);
	});

	test("refuses unsafe URLs, tokens and empty names", () => {
		for (const serverUrl of [
			"ftp://isolate.example.com",
			"https://user:pass@isolate.example.com",
			"https://isolate.example.com/?next=x",
			"not a url",
		]) {
			expect(
				buildRelayInstallCommand({ serverUrl, token, name: "relay" }),
			).toBeNull();
		}
		expect(
			buildRelayInstallCommand({
				serverUrl: "https://isolate.example.com",
				token: "short",
				name: "relay",
			}),
		).toBeNull();
		expect(
			buildRelayInstallCommand({
				serverUrl: "https://isolate.example.com",
				token,
				name: "   ",
			}),
		).toBeNull();
	});
});

describe("readSetupState", () => {
	test("binds the organization and maps the first row", async () => {
		const calls: { query: string; parameters: readonly unknown[] }[] = [];
		const sql = {
			async unsafe(query: string, parameters?: readonly unknown[]) {
				calls.push({ query, parameters: parameters ?? [] });
				return [
					{
						github_connected: true,
						relay_active: false,
						connection_active: false,
						trigger_enabled: false,
						first_run: false,
						has_repository: true,
						has_relay: false,
						has_connection: false,
						active_connector_id: null,
					},
				];
			},
		};
		const result = await readSetupState(sql, ORG);
		expect(SETUP_STATE_SQL).toContain("organization_id = $1");
		expect(calls[0]?.parameters).toEqual([ORG]);
		expect(result.githubConnected).toBe(true);
		expect(result.hasRepository).toBe(true);
		expect(result.complete).toBe(false);
	});

	test("fails closed when the driver returns no row", async () => {
		await expect(
			readSetupState(
				{
					async unsafe() {
						return [];
					},
				},
				ORG,
			),
		).rejects.toThrow("no row");
	});
});
