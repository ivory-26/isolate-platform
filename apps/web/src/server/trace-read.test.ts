import { describe, expect, test } from "bun:test";
import type {
	GetTaskTraceInput,
	TaskTrace,
	TaskTraceRepository,
	UserRole,
} from "@isolate/db";
import { asOrganizationId, asTaskId, asUserId } from "@isolate/shared";
import { type CallerScope, ControlPlaneError } from "./task-service.server";
import {
	createTraceReadRoutes,
	createTraceReadService,
	handleTaskTraceRoute,
	normalizeTraceTaskId,
	readTraceTaskId,
	resetTraceReadForTests,
	type TraceReadRoutes,
} from "./trace-read.server";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const USER_A = asUserId("22222222-2222-4222-8222-222222222222");
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_ID = "44444444-4444-4444-8444-444444444444";

function fixtureTrace(taskId: string = TASK_ID): TaskTrace {
	return {
		taskId,
		traceId: "a".repeat(32),
		events: [
			{
				type: "task.claimed",
				actor: "worker",
				data: { turn: 1 },
				createdAt: "2026-11-01T10:00:00.000Z",
			},
		],
		toolInvocations: [
			{
				toolName: "connector.github.issue",
				decision: "allowed",
				denialReason: null,
				argumentsHash: "b".repeat(64),
				durationMs: 4,
				createdAt: "2026-11-01T10:00:01.000Z",
			},
		],
		usage: [
			{
				provider: "baseten",
				modelId: "model-a",
				promptTokens: 3,
				completionTokens: 2,
				costUsd: "0.000100",
				createdAt: "2026-11-01T10:00:02.000Z",
			},
		],
		connectorCalls: [
			{
				toolName: "connector.github.issue",
				connectorId: "github",
				status: "completed",
				errorCode: null,
				attempts: 1,
				traceparent: `00-${"a".repeat(32)}-${"c".repeat(16)}-01`,
				createdAt: "2026-11-01T10:00:03.000Z",
				claimedAt: "2026-11-01T10:00:04.000Z",
				completedAt: "2026-11-01T10:00:05.000Z",
				expiresAt: "2026-11-01T10:01:00.000Z",
			},
		],
	};
}

class RecordingTraceRepository implements TaskTraceRepository {
	readonly calls: GetTaskTraceInput[] = [];

	constructor(
		private readonly result: TaskTrace | null,
		private readonly failure: Error | null = null,
	) {}

	async getTaskTrace(input: GetTaskTraceInput): Promise<TaskTrace | null> {
		this.calls.push(input);
		if (this.failure !== null) throw this.failure;
		return this.result;
	}
}

function scope(role: UserRole = "member"): CallerScope {
	return { organizationId: ORG_A, userId: USER_A, role };
}

type Harness = {
	routes: TraceReadRoutes;
	traces: RecordingTraceRepository;
	scopeCalls: () => number;
};

function setup(
	options: {
		role?: UserRole;
		result?: TaskTrace | null;
		failure?: Error;
		resolveScope?: () => Promise<CallerScope>;
		missingScope?: boolean;
	} = {},
): Harness {
	let scopeCalls = 0;
	const traces = new RecordingTraceRepository(
		options.result === undefined ? fixtureTrace() : options.result,
		options.failure ?? null,
	);
	const routes = createTraceReadRoutes({
		resolveScope: async () => {
			scopeCalls += 1;
			if (options.missingScope === true) {
				throw new ControlPlaneError("AUTH_REQUIRED");
			}
			if (options.resolveScope !== undefined) return options.resolveScope();
			return scope(options.role ?? "member");
		},
		traces,
	});
	return { routes, traces, scopeCalls: () => scopeCalls };
}

function get(taskId: string, init: RequestInit = {}): Request {
	return new Request(`http://localhost/api/traces/${taskId}`, {
		method: "GET",
		...init,
	});
}

async function body(response: Response): Promise<Record<string, unknown>> {
	const parsed: unknown = await response.json();
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("expected a JSON object");
	}
	return parsed as Record<string, unknown>;
}

describe("trace read service", () => {
	test("checks task:read before touching storage", async () => {
		const { traces } = setup();
		const service = createTraceReadService({
			resolveScope: async () => scope(),
			traces,
		});
		// An unknown role is the only way to lose `task:read`; the gate must run
		// before the repository, so a denied caller learns nothing about the task.
		await expect(
			service.getTaskTrace(scope("intruder" as UserRole), { taskId: TASK_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(traces.calls).toHaveLength(0);
	});

	test("scopes the storage read to the caller's organization", async () => {
		const { traces } = setup();
		const service = createTraceReadService({
			resolveScope: async () => scope(),
			traces,
		});
		const trace = await service.getTaskTrace(scope("viewer"), {
			taskId: TASK_ID,
		});
		expect(trace.taskId).toBe(TASK_ID);
		expect(traces.calls).toEqual([
			{ organizationId: ORG_A, taskId: asTaskId(TASK_ID) },
		]);
	});

	test("a foreign or missing task is one fixed NOT_FOUND", async () => {
		const { traces } = setup({ result: null });
		const service = createTraceReadService({
			resolveScope: async () => scope(),
			traces,
		});
		await expect(
			service.getTaskTrace(scope(), { taskId: MISSING_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND", message: "task not found" });
	});

	test("rejects a malformed task id before any storage read", async () => {
		const { traces } = setup();
		const service = createTraceReadService({
			resolveScope: async () => scope(),
			traces,
		});
		await expect(
			service.getTaskTrace(scope(), { taskId: "not-a-uuid" }),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		await expect(service.getTaskTrace(scope(), null)).rejects.toMatchObject({
			code: "VALIDATION_FAILED",
		});
		expect(traces.calls).toHaveLength(0);
	});
});

describe("trace read route", () => {
	test("serves the trace with no-store and no secret fields", async () => {
		const harness = setup();
		const response = await harness.routes.get(get(TASK_ID));
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const payload = await body(response);
		expect(Object.keys(payload).sort()).toEqual([
			"connectorCalls",
			"events",
			"taskId",
			"toolInvocations",
			"traceId",
			"usage",
		]);
		expect(payload.taskId).toBe(TASK_ID);
		expect(harness.traces.calls[0].organizationId).toBe(ORG_A);
		const text = JSON.stringify(payload);
		expect(text).not.toContain("arguments_redacted");
		expect(text).not.toContain('"params"');
		expect(text).not.toContain('"result"');
	});

	test("normalizes an upper-case id and rejects a malformed path with 400", async () => {
		const harness = setup();
		const upper = TASK_ID.toUpperCase();
		expect((await harness.routes.get(get(upper))).status).toBe(200);
		expect(harness.traces.calls[0].taskId).toBe(asTaskId(TASK_ID));

		const malformed = await harness.routes.get(get("not-a-uuid"));
		expect(malformed.status).toBe(400);
		expect(await body(malformed)).toEqual({
			error: "trace request is invalid",
		});
		// The path is refused before a session lookup.
		expect(harness.scopeCalls()).toBe(1);
		expect(harness.traces.calls).toHaveLength(1);
	});

	test("maps missing auth, forbidden, not found and failure to fixed bodies", async () => {
		const unauthenticated = setup({ missingScope: true });
		const unauthorized = await unauthenticated.routes.get(get(TASK_ID));
		expect(unauthorized.status).toBe(401);
		expect(await body(unauthorized)).toEqual({
			error: "authentication required",
		});

		const forbidden = setup({ role: "intruder" as UserRole });
		const denied = await forbidden.routes.get(get(TASK_ID));
		expect(denied.status).toBe(403);
		expect(await body(denied)).toEqual({ error: "forbidden" });
		expect(forbidden.traces.calls).toHaveLength(0);

		const missing = setup({ result: null });
		const notFound = await missing.routes.get(get(MISSING_ID));
		expect(notFound.status).toBe(404);
		expect(await body(notFound)).toEqual({ error: "task not found" });

		const broken = setup({ failure: new Error("driver password: hunter2") });
		const unavailable = await broken.routes.get(get(TASK_ID));
		expect(unavailable.status).toBe(503);
		const fixed = await body(unavailable);
		expect(fixed).toEqual({ error: "trace read is unavailable" });
		expect(JSON.stringify(fixed)).not.toContain("driver");
	});

	test("refuses a non-GET method and a cross-origin request", async () => {
		const harness = setup();
		const post = await harness.routes.get(
			new Request(`http://localhost/api/traces/${TASK_ID}`, { method: "POST" }),
		);
		expect(post.status).toBe(405);

		const crossOrigin = await harness.routes.get(
			get(TASK_ID, { headers: { origin: "https://evil.example" } }),
		);
		expect(crossOrigin.status).toBe(403);
		expect(await body(crossOrigin)).toEqual({ error: "request rejected" });
		expect(harness.traces.calls).toHaveLength(0);
	});

	test("the production handler answers a fixed 503 without configuration", async () => {
		resetTraceReadForTests();
		const response = await handleTaskTraceRoute(get(TASK_ID), {});
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await body(response)).toEqual({
			error: "trace read is unavailable",
		});
	});
});

describe("path readers", () => {
	test("readTraceTaskId takes only the last segment under /traces", () => {
		expect(readTraceTaskId(get(TASK_ID))).toBe(TASK_ID);
		expect(readTraceTaskId(get(`${TASK_ID}/extra`))).toBeNull();
		expect(
			readTraceTaskId(new Request("http://localhost/api/traces/")),
		).toBeNull();
		expect(normalizeTraceTaskId("ABC")).toBeNull();
		expect(normalizeTraceTaskId(TASK_ID.toUpperCase())).toBe(TASK_ID);
	});
});
