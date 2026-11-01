import { describe, expect, test } from "bun:test";
import type { UserRole } from "@isolate/db";
import { asOrganizationId, asUserId } from "@isolate/shared";
import {
	createOverviewReadService,
	groupWorkflowOptions,
	mapActiveRun,
	mapDevice,
	type OverviewReadRepository,
} from "../../server/overview-read.server";
import type { CallerScope } from "../../server/task-service.server";

const ORG = asOrganizationId("11111111-1111-4111-8111-111111111111");
const USER = asUserId("22222222-2222-4222-8222-222222222222");
const NOW = new Date("2026-11-20T12:00:00.000Z");

function scope(role: UserRole = "member"): CallerScope {
	return { organizationId: ORG, userId: USER, role };
}

type Recorded = { method: string; scope: CallerScope; args: unknown[] };

function fakeRepository(overrides: Partial<OverviewReadRepository> = {}): {
	repository: OverviewReadRepository;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const repository: OverviewReadRepository = {
		async getOrganization(input) {
			calls.push({ method: "getOrganization", scope: input, args: [] });
			return { name: "Ivory Labs", slug: "ivory-labs" };
		},
		async countTaskStatuses(input) {
			calls.push({ method: "countTaskStatuses", scope: input, args: [] });
			return { queued: 2, executing: 3, review_ready: 1, completed: 9 };
		},
		async countRecentFailures(input, sinceIso) {
			calls.push({
				method: "countRecentFailures",
				scope: input,
				args: [sinceIso],
			});
			return 1;
		},
		async countPendingApprovals(input, nowIso) {
			calls.push({
				method: "countPendingApprovals",
				scope: input,
				args: [nowIso],
			});
			return 2;
		},
		async listActiveRuns(input, limit) {
			calls.push({ method: "listActiveRuns", scope: input, args: [limit] });
			return [
				{
					taskId: "33333333-3333-4333-8333-333333333333",
					repositoryName: "ivory-26/agent-bank",
					branch: "task/web-demo",
					status: "executing",
					createdAt: "2026-11-20T11:00:00.000Z",
					updatedAt: "2026-11-20T11:55:00.000Z",
					runStatus: "running",
					runStartedAt: "2026-11-20T11:30:00.000Z",
					latestEventType: "workflow.step_started",
					latestEventAt: "2026-11-20T11:59:00.000Z",
				},
			];
		},
		async listPendingApprovals(input, limit, nowIso) {
			calls.push({
				method: "listPendingApprovals",
				scope: input,
				args: [limit, nowIso],
			});
			return [
				{
					approvalId: "44444444-4444-4444-8444-444444444444",
					taskId: "33333333-3333-4333-8333-333333333333",
					action: "git.push_branch",
					requestedBy: "worker",
					createdAt: "2026-11-20T11:50:00.000Z",
					expiresAt: "2026-11-20T12:20:00.000Z",
					repositoryName: "ivory-26/agent-bank",
					branch: "task/web-demo",
				},
			];
		},
		async listActivity(input, limit) {
			calls.push({ method: "listActivity", scope: input, args: [limit] });
			return [
				{
					id: "event-1",
					taskId: "33333333-3333-4333-8333-333333333333",
					type: "approval.requested",
					actor: "worker",
					occurredAt: "2026-11-20T11:51:00.000Z",
					branch: "task/web-demo",
				},
			];
		},
		async listDevices(input, limit) {
			calls.push({ method: "listDevices", scope: input, args: [limit] });
			return [
				{
					id: "device-1",
					displayName: "Sahil laptop",
					status: "active",
					lastSeenAt: "2026-11-20T11:40:00.000Z",
					createdAt: "2026-11-01T09:00:00.000Z",
				},
				{
					id: "device-2",
					displayName: "Old laptop",
					status: "pending",
					lastSeenAt: null,
					createdAt: "2026-11-02T09:00:00.000Z",
				},
			];
		},
		async listRepositories(input, limit) {
			calls.push({ method: "listRepositories", scope: input, args: [limit] });
			return [
				{
					id: "55555555-5555-4555-8555-555555555555",
					name: "ivory-26/agent-bank",
					defaultBranch: "main",
				},
			];
		},
		async listWorkflowVersions(input, limit) {
			calls.push({
				method: "listWorkflowVersions",
				scope: input,
				args: [limit],
			});
			return [
				{
					definitionId: "66666666-6666-4666-8666-666666666666",
					name: "SDLC demo",
					version: 2,
				},
				{
					definitionId: "66666666-6666-4666-8666-666666666666",
					name: "SDLC demo",
					version: 1,
				},
			];
		},
		...overrides,
	};
	return { repository, calls };
}

describe("overview read service", () => {
	test("assembles measured metrics, runs, approvals, activity and devices", async () => {
		const { repository, calls } = fakeRepository();
		const snapshot = await createOverviewReadService(repository).readOverview(
			scope(),
			NOW,
		);

		expect(snapshot.generatedAt).toBe(NOW.toISOString());
		expect(snapshot.organization).toEqual({
			id: ORG,
			name: "Ivory Labs",
			slug: "ivory-labs",
		});
		expect(snapshot.metrics).toEqual({
			activeTasks: 4,
			queuedTasks: 2,
			pendingApprovals: 2,
			recentFailures: 1,
			failureWindowHours: 24,
		});
		expect(snapshot.activeRuns).toHaveLength(1);
		expect(snapshot.activeRuns[0]?.elapsedMs).toBe(30 * 60_000);
		expect(snapshot.activeRuns[0]?.stageLabel).toBe("Step started");
		expect(snapshot.activeRuns[0]?.latestUpdateAt).toBe(
			"2026-11-20T11:59:00.000Z",
		);
		expect(snapshot.pendingApprovals[0]?.risk.level).toBe("high");
		expect(snapshot.pendingApprovals[0]?.actionLabel).toBe("Push branch");
		expect(snapshot.activity[0]?.typeLabel).toBe("Approval requested");
		expect(snapshot.devices.map((device) => device.status)).toEqual([
			"active",
			"pending",
		]);

		// Every read was scoped to the trusted organization.
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.scope.organizationId).toBe(ORG);
		}
		const failureCall = calls.find(
			(call) => call.method === "countRecentFailures",
		);
		expect(failureCall?.args).toEqual(["2026-11-19T12:00:00.000Z"]);
	});

	test("an organization without stored rows still yields a complete snapshot", async () => {
		const { repository } = fakeRepository({
			getOrganization: async () => null,
			countTaskStatuses: async () => ({}),
			countRecentFailures: async () => 0,
			countPendingApprovals: async () => 0,
			listActiveRuns: async () => [],
			listPendingApprovals: async () => [],
			listActivity: async () => [],
			listDevices: async () => [],
		});
		const snapshot = await createOverviewReadService(repository).readOverview(
			scope("viewer"),
			NOW,
		);
		expect(snapshot.organization).toBeNull();
		expect(snapshot.metrics.activeTasks).toBe(0);
		expect(snapshot.activeRuns).toEqual([]);
		expect(snapshot.pendingApprovals).toEqual([]);
		expect(snapshot.activity).toEqual([]);
		expect(snapshot.devices).toEqual([]);
	});

	test("submit options group versions newest first", async () => {
		const { repository } = fakeRepository({
			listWorkflowVersions: async () => [
				{ definitionId: "def-b", name: "Zeta", version: 1 },
				{ definitionId: "def-a", name: "Alpha", version: 7 },
				{ definitionId: "def-b", name: "Zeta", version: 3 },
				{ definitionId: "def-a", name: "Alpha", version: 7 },
				{ definitionId: "def-c", name: "No versions", version: null },
			],
		});
		const options = await createOverviewReadService(
			repository,
		).readSubmitOptions(scope());
		expect(options.repositories).toHaveLength(1);
		expect(options.repositories[0]?.name).toBe("ivory-26/agent-bank");
		expect(options.workflows.map((workflow) => workflow.name)).toEqual([
			"Alpha",
			"No versions",
			"Zeta",
		]);
		expect(options.workflows[0]?.versions).toEqual([7]);
		expect(options.workflows[1]?.versions).toEqual([]);
		expect(options.workflows[2]?.versions).toEqual([3, 1]);
	});
});

describe("overview row mapping", () => {
	test("an active run without a workflow run starts from task creation", () => {
		const summary = mapActiveRun(
			{
				taskId: "33333333-3333-4333-8333-333333333333",
				repositoryName: "ivory-26/agent-bank",
				branch: "task/queued",
				status: "planning",
				createdAt: "2026-11-20T10:00:00.000Z",
				updatedAt: "2026-11-20T10:05:00.000Z",
				runStatus: null,
				runStartedAt: null,
				latestEventType: null,
				latestEventAt: null,
			},
			NOW,
		);
		expect(summary.startedAt).toBe("2026-11-20T10:00:00.000Z");
		expect(summary.stageLabel).toBe("No events yet");
		expect(summary.latestUpdateAt).toBe("2026-11-20T10:05:00.000Z");
	});

	test("unknown device status is not reported as active", () => {
		const device = mapDevice({
			id: "device-x",
			displayName: "Unknown",
			status: "something-else",
			lastSeenAt: null,
			createdAt: "2026-11-01T00:00:00.000Z",
		});
		expect(device.status).toBe("pending");
	});

	test("groupWorkflowOptions keeps the first name for a definition", () => {
		const grouped = groupWorkflowOptions([
			{ definitionId: "def", name: "First", version: 2 },
			{ definitionId: "def", name: "First", version: 1 },
		]);
		expect(grouped).toEqual([{ id: "def", name: "First", versions: [2, 1] }]);
	});
});
