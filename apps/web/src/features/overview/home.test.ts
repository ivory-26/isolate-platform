import { describe, expect, test } from "bun:test";
import type { UserRole } from "@isolate/db";
import { asOrganizationId, asUserId } from "@isolate/shared";
import {
	createOverviewReadService,
	mapHomeConnectors,
	mapHomeRelays,
	mapRetryableFailure,
	type OverviewReadRepository,
} from "../../server/overview-read.server";
import type { CallerScope } from "../../server/task-service.server";
import type { IntegrationConnection } from "../integrations/contracts";
import type { IntegrationAggregate } from "../integrations/integrations-read.server";
import {
	deriveHomeMetrics,
	HOME_WINDOW_HOURS,
	homePrimaryAction,
	isNewOrganization,
	showsSetupBanner,
} from "./contracts";

/**
 * Home snapshot tests (wave 23): metric derivation, primary-action selection
 * and the mapping from bounded rows to the sections Home renders.
 */

const ORG = asOrganizationId("11111111-1111-4111-8111-111111111111");
const USER = asUserId("22222222-2222-4222-8222-222222222222");
const NOW = new Date("2026-11-20T12:00:00.000Z");

function scope(role: UserRole = "member"): CallerScope {
	return { organizationId: ORG, userId: USER, role };
}

function emptyFake(
	overrides: Partial<OverviewReadRepository> = {},
): OverviewReadRepository {
	return {
		async getOrganization() {
			return { name: "Ivory Labs", slug: "ivory-labs" };
		},
		async countTaskStatuses() {
			return {};
		},
		async countRecentFailures() {
			return 0;
		},
		async countPendingApprovals() {
			return 0;
		},
		async listActiveRuns() {
			return [];
		},
		async listPendingApprovals() {
			return [];
		},
		async listActivity() {
			return [];
		},
		async listDevices() {
			return [];
		},
		async listRepositories() {
			return [];
		},
		async listWorkflowVersions() {
			return [];
		},
		async countEventsSince() {
			return 0;
		},
		async countAutonomousTasksSince() {
			return 0;
		},
		async countRetryableFailures() {
			return 0;
		},
		async listRetryableFailures() {
			return [];
		},
		async countRepositories() {
			return 0;
		},
		async listInboxDeliveries() {
			return [];
		},
		async readIntegrationAggregate() {
			return {
				connections: new Map(),
				triggerCounts: new Map(),
				enabledTriggerCounts: new Map(),
				lastEventAt: new Map(),
				usage: new Map(),
			};
		},
		async readSetup() {
			return {
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
		},
		...overrides,
	};
}

describe("home metrics", () => {
	test("needs you is approvals plus retryable failures; running excludes paused work", () => {
		const metrics = deriveHomeMetrics({
			statusCounts: {
				planning: 1,
				executing: 2,
				validating: 1,
				repairing: 0,
				awaiting_approval: 4,
				review_ready: 3,
				queued: 5,
			},
			pendingApprovals: 2,
			retryableFailures: 3,
			events24h: 17,
			autonomousTasks24h: 6,
		});
		expect(metrics).toEqual({
			needsYou: 5,
			running: 4,
			events24h: 17,
			autonomousTasks24h: 6,
			windowHours: HOME_WINDOW_HOURS,
		});
	});

	test("unknown, negative and non-finite counts become zero", () => {
		const metrics = deriveHomeMetrics({
			statusCounts: { executing: -2, planning: Number.NaN, mystery: 9 },
			pendingApprovals: -1,
			retryableFailures: Number.POSITIVE_INFINITY,
			events24h: 2.8,
			autonomousTasks24h: -4,
		});
		expect(metrics.needsYou).toBe(0);
		expect(metrics.running).toBe(0);
		expect(metrics.events24h).toBe(2);
		expect(metrics.autonomousTasks24h).toBe(0);
	});
});

describe("home primary action", () => {
	test("approvals win over the inbox only when one is pending", () => {
		expect(
			homePrimaryAction({ pendingApprovals: 1, retryableFailures: 4 }),
		).toBe("approvals");
		expect(
			homePrimaryAction({ pendingApprovals: 0, retryableFailures: 4 }),
		).toBe("inbox");
		expect(
			homePrimaryAction({ pendingApprovals: -3, retryableFailures: 0 }),
		).toBe("inbox");
	});
});

describe("home empty states", () => {
	test("a new organization shows setup, an existing one does not", () => {
		const base = {
			generatedAt: NOW.toISOString(),
			organization: null,
			metrics: deriveHomeMetrics({
				statusCounts: {},
				pendingApprovals: 0,
				retryableFailures: 0,
				events24h: 0,
				autonomousTasks24h: 0,
			}),
			activeRuns: [],
			pendingApprovals: [],
			retryableFailures: [],
			inbox: [],
			sources: {
				github: { connected: false, repositoryCount: 0 },
				connectors: [],
				relays: [],
			},
		};
		const fresh = {
			...base,
			setup: {
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
			},
		};
		expect(isNewOrganization(fresh)).toBe(true);
		expect(showsSetupBanner(fresh.setup)).toBe(true);

		const existing = {
			...fresh,
			setup: { ...fresh.setup, firstRun: true, hasRepository: true },
		};
		expect(isNewOrganization(existing)).toBe(false);
		expect(showsSetupBanner(existing.setup)).toBe(true);

		const complete = {
			...existing,
			setup: { ...existing.setup, complete: true },
		};
		expect(showsSetupBanner(complete.setup)).toBe(false);
	});
});

const CONNECTION: IntegrationConnection = {
	id: "99999999-9999-4999-8999-999999999999",
	connectorId: "sentry",
	displayName: "Sentry metadata",
	authKind: "api_key",
	status: "active",
	relayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	relayName: "Sahil laptop",
	relayStatus: "active",
	scopes: [],
	enabledTools: [],
	lastValidatedAt: "2026-11-20T10:00:00.000Z",
	lastUsedAt: null,
};

describe("home source mapping", () => {
	test("only relay-paired connectors with a credential are listed", () => {
		const aggregate: IntegrationAggregate = {
			connections: new Map([
				["sentry", CONNECTION],
				["github", { ...CONNECTION, connectorId: "github" }],
			]),
			triggerCounts: new Map([
				["sentry", 2],
				["github", 9],
			]),
			enabledTriggerCounts: new Map([
				["sentry", 1],
				["github", 9],
			]),
			lastEventAt: new Map([["sentry", "2026-11-20T11:00:00.000Z"]]),
			usage: new Map(),
		};
		const sources = mapHomeConnectors(aggregate);
		expect(sources.map((source) => source.connectorId)).toEqual(["sentry"]);
		expect(sources[0]).toEqual({
			connectorId: "sentry",
			label: "Sentry",
			status: "active",
			lastVerifiedAt: "2026-11-20T10:00:00.000Z",
			lastEventAt: "2026-11-20T11:00:00.000Z",
			triggerCount: 2,
			enabledTriggerCount: 1,
			relayName: "Sahil laptop",
			relayStatus: "active",
		});
	});

	test("relays keep their stored status and unknown states become pending", () => {
		const relays = mapHomeRelays([
			{
				id: "relay-1",
				displayName: "Laptop",
				status: "active",
				lastSeenAt: "2026-11-20T11:40:00.000Z",
				createdAt: "2026-11-01T00:00:00.000Z",
			},
			{
				id: "relay-2",
				displayName: "Old box",
				status: "something-else",
				lastSeenAt: null,
				createdAt: "2026-11-01T00:00:00.000Z",
			},
		]);
		expect(relays.map((relay) => relay.status)).toEqual(["active", "pending"]);
	});

	test("retryable failures carry the retry depth and cap", () => {
		expect(
			mapRetryableFailure({
				taskId: "77777777-7777-4777-8777-777777777777",
				repositoryName: "ivory-26/agent-bank",
				branch: "task/failed",
				status: "failed",
				updatedAt: "2026-11-20T11:10:00.000Z",
				retryDepth: 2,
			}),
		).toEqual({
			taskId: "77777777-7777-4777-8777-777777777777",
			repositoryName: "ivory-26/agent-bank",
			branch: "task/failed",
			status: "failed",
			failedAt: "2026-11-20T11:10:00.000Z",
			retryDepth: 2,
			maxRetryDepth: 3,
		});
	});
});

describe("readHome", () => {
	test("assembles setup, metrics, inbox and sources from bounded reads", async () => {
		const repository = emptyFake({
			async countTaskStatuses() {
				return { executing: 2, awaiting_approval: 1 };
			},
			async countPendingApprovals() {
				return 1;
			},
			async countRetryableFailures() {
				return 2;
			},
			async countEventsSince() {
				return 12;
			},
			async countAutonomousTasksSince() {
				return 5;
			},
			async countRepositories() {
				return 4;
			},
			async listActiveRuns() {
				return [
					{
						taskId: "33333333-3333-4333-8333-333333333333",
						repositoryName: "ivory-26/agent-bank",
						branch: "event/sentry-1",
						status: "executing",
						createdAt: "2026-11-20T11:00:00.000Z",
						updatedAt: "2026-11-20T11:55:00.000Z",
						runStatus: "running",
						runStartedAt: "2026-11-20T11:30:00.000Z",
						latestEventType: "agent.turn_started",
						latestEventAt: "2026-11-20T11:59:00.000Z",
						incidentSource: "sentry",
						autonomyLevel: "A2",
					},
				];
			},
			async listInboxDeliveries() {
				return [
					{
						id: "88888888-8888-4888-8888-888888888888",
						connector: "sentry",
						source: "sentry",
						eventKind: "issue.created",
						severity: "critical",
						status: "task_created",
						reasonCode: null,
						title: "Checkout failures spiked",
						summary: "",
						links: [],
						repository: "ivory-26/agent-bank",
						taskId: "33333333-3333-4333-8333-333333333333",
						receivedAt: "2026-11-20T11:45:00.000Z",
						processedAt: null,
					},
				];
			},
			async readSetup() {
				return {
					githubConnected: true,
					relayActive: true,
					connectionActive: true,
					triggerEnabled: false,
					firstRun: true,
					complete: false,
					hasRepository: true,
					hasRelay: true,
					hasConnection: true,
					activeConnectorId: "sentry" as const,
				};
			},
			async readIntegrationAggregate() {
				return {
					connections: new Map([["sentry", CONNECTION]]),
					triggerCounts: new Map([["sentry", 1]]),
					enabledTriggerCounts: new Map([["sentry", 1]]),
					lastEventAt: new Map([["sentry", "2026-11-20T11:45:00.000Z"]]),
					usage: new Map(),
				};
			},
			async listDevices() {
				return [
					{
						id: "relay-1",
						displayName: "Sahil laptop",
						status: "active",
						lastSeenAt: "2026-11-20T11:40:00.000Z",
						createdAt: "2026-11-01T00:00:00.000Z",
					},
				];
			},
		});

		const snapshot = await createOverviewReadService(repository).readHome(
			scope(),
			NOW,
		);
		expect(snapshot.generatedAt).toBe(NOW.toISOString());
		expect(snapshot.setup.complete).toBe(false);
		expect(snapshot.metrics).toEqual({
			needsYou: 3,
			running: 2,
			events24h: 12,
			autonomousTasks24h: 5,
			windowHours: HOME_WINDOW_HOURS,
		});
		expect(snapshot.activeRuns[0]?.incidentSource).toBe("sentry");
		expect(snapshot.inbox[0]?.statusLabel).toBe("Task created");
		expect(snapshot.sources.github).toEqual({
			connected: true,
			repositoryCount: 4,
		});
		expect(snapshot.sources.connectors[0]?.connectorId).toBe("sentry");
		expect(snapshot.sources.relays[0]?.status).toBe("active");
	});

	test("an empty organization still yields a complete home snapshot", async () => {
		const snapshot = await createOverviewReadService(emptyFake()).readHome(
			scope("viewer"),
			NOW,
		);
		expect(snapshot.metrics.needsYou).toBe(0);
		expect(snapshot.activeRuns).toEqual([]);
		expect(snapshot.pendingApprovals).toEqual([]);
		expect(snapshot.retryableFailures).toEqual([]);
		expect(snapshot.inbox).toEqual([]);
		expect(snapshot.sources.connectors).toEqual([]);
		expect(isNewOrganization(snapshot)).toBe(true);
	});
});
