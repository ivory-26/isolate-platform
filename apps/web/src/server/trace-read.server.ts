import "@tanstack/react-start/server-only";
import {
	createDb,
	hasCapability,
	type PgSql,
	type PlatformCapability,
	PostgresTraceReadRepository,
	type TaskTrace,
	type TaskTraceRepository,
	type UserRole,
} from "@isolate/db";
import { asTaskId, PlatformError } from "@isolate/shared";
import { readActiveOrganizationPreference } from "./active-organization.server";
import { type AuthRuntime, createAuthRuntime } from "./auth-runtime.server";
import { resolveCallerScope } from "./caller-scope.server";
import { readNeonAuthSettings } from "./neon-auth.server";
import { assertSameOrigin, RequestGuardError } from "./request-guard.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

/**
 * Trace read surface (wave 19).
 *
 * `GET /api/traces/{taskId}` returns one tenant-scoped task run reconstructed
 * from durable rows (`run_events`, `tool_invocations`, `usage_records`,
 * `connector_calls`). Read-only and server-only:
 *
 * - the task id is validated as a UUID before any storage read, so a malformed
 *   path is a fixed 400 rather than a database cast error;
 * - `task:read` is checked BEFORE the repository is called, so a caller who
 *   lacks the capability cannot even learn whether the task exists;
 * - tenancy comes only from the trusted session-derived scope; a foreign task
 *   is a fixed 404, indistinguishable from a missing one;
 * - every response is `Cache-Control: no-store`, and every failure body is
 *   fixed text: no request value, driver message or repository error escapes.
 */

const TRACE_UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_STORE = {
	"cache-control": "no-store",
	pragma: "no-cache",
} as const;

const ROLES: ReadonlySet<string> = new Set([
	"owner",
	"admin",
	"member",
	"viewer",
] satisfies UserRole[]);

export function normalizeTraceTaskId(value: unknown): string | null {
	if (typeof value !== "string" || !TRACE_UUID_PATTERN.test(value)) return null;
	return value.toLowerCase();
}

/** `GET /api/traces/{taskId}` — the id is the last path segment. */
export function readTraceTaskId(request: Request): string | null {
	let segments: string[];
	try {
		segments = new URL(request.url).pathname.split("/").filter(Boolean);
	} catch {
		return null;
	}
	const index = segments.lastIndexOf("traces");
	if (index < 0 || index + 2 !== segments.length) return null;
	return normalizeTraceTaskId(segments[index + 1]);
}

function requireScope(
	scope: CallerScope,
	capability: PlatformCapability,
): CallerScope {
	if (!ROLES.has(scope.role) || !hasCapability(scope.role, capability)) {
		throw new ControlPlaneError("FORBIDDEN");
	}
	return scope;
}

export type TraceReadDependencies = {
	/** Trusted server-side caller identity; never request data. */
	resolveScope: () => Promise<CallerScope>;
	traces: Pick<TaskTraceRepository, "getTaskTrace">;
};

export type TraceReadService = {
	getTaskTrace(scope: CallerScope, input: unknown): Promise<TaskTrace>;
};

/**
 * Pure service over an injected repository. The capability gate runs before
 * the storage read; a missing or foreign task is one fixed `NOT_FOUND`.
 */
export function createTraceReadService(
	dependencies: TraceReadDependencies,
): TraceReadService {
	return {
		async getTaskTrace(scope, input) {
			const candidate =
				typeof input === "object" && input !== null
					? (input as { taskId?: unknown }).taskId
					: undefined;
			const taskId = normalizeTraceTaskId(candidate);
			if (taskId === null) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"trace request is invalid",
				);
			}
			// Capability before storage: a denied caller touches no row.
			requireScope(scope, "task:read");
			const trace = await dependencies.traces.getTaskTrace({
				organizationId: scope.organizationId,
				taskId: asTaskId(taskId),
			});
			// A foreign-tenant trace is indistinguishable from a missing one.
			if (trace === null) {
				throw new PlatformError("NOT_FOUND", "task not found");
			}
			return trace;
		},
	};
}

function json(status: number, body: unknown): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

function fixedError(status: number, error: string): Response {
	return json(status, { error });
}

function unavailable(): Response {
	return fixedError(503, "trace read is unavailable");
}

/** Maps a service failure to fixed text; never serializes the thrown value. */
function failureResponse(error: unknown): Response {
	if (error instanceof RequestGuardError) {
		return fixedError(error.status, "request rejected");
	}
	if (error instanceof ControlPlaneError) {
		if (error.code === "AUTH_REQUIRED") {
			return fixedError(401, "authentication required");
		}
		if (error.code === "FORBIDDEN") return fixedError(403, "forbidden");
	}
	if (error instanceof PlatformError) {
		switch (error.code) {
			case "VALIDATION_FAILED":
				return fixedError(400, "trace request is invalid");
			case "NOT_FOUND":
				return fixedError(404, "task not found");
			default:
				break;
		}
	}
	// A driver/connection failure is a 503, never a 500 that leaks a message.
	return unavailable();
}

export type TraceReadRoutes = {
	get(request: Request): Promise<Response>;
};

/** Route adapter over the pure service; every response is no-store. */
export function createTraceReadRoutes(
	dependencies: TraceReadDependencies,
): TraceReadRoutes {
	const service = createTraceReadService(dependencies);

	return {
		async get(request) {
			if (request.method !== "GET") {
				return fixedError(405, "method not allowed");
			}
			try {
				assertSameOrigin(request);
			} catch (error) {
				return failureResponse(error);
			}
			// The path is validated before a session lookup or a query.
			const taskId = readTraceTaskId(request);
			if (taskId === null) {
				return fixedError(400, "trace request is invalid");
			}
			try {
				const scope = await dependencies.resolveScope();
				return json(200, await service.getTaskTrace(scope, { taskId }));
			} catch (error) {
				return failureResponse(error);
			}
		},
	};
}

/** Missing or unusable deployment configuration; the route answers 503. */
export class TraceReadNotConfiguredError extends Error {
	constructor() {
		super("trace read is not configured");
		this.name = "TraceReadNotConfiguredError";
	}
}

type TraceReadRuntime = {
	databaseUrl: string;
	baseUrl: string;
	cookieSecret: string;
	auth: AuthRuntime;
	traces: TaskTraceRepository;
};

let sql: PgSql | undefined;
let sqlUrl: string | undefined;
let runtime: TraceReadRuntime | undefined;

function getSql(databaseUrl: string): PgSql {
	if (sql === undefined || sqlUrl !== databaseUrl) {
		sql = createDb(databaseUrl);
		sqlUrl = databaseUrl;
	}
	return sql;
}

/**
 * Production wiring: database plus the Neon Auth session/membership readers,
 * using the same runtime pattern as device registration. Missing config fails
 * closed before any query.
 */
export function getTraceReadRoutes(
	env: Record<string, string | undefined> = process.env,
): TraceReadRoutes {
	const databaseUrl = env.DATABASE_URL?.trim();
	if (databaseUrl === undefined || databaseUrl.length === 0) {
		throw new TraceReadNotConfiguredError();
	}
	const settings = readNeonAuthSettings(env);
	if (settings === null) throw new ControlPlaneError("AUTH_REQUIRED");

	if (
		runtime === undefined ||
		runtime.databaseUrl !== databaseUrl ||
		runtime.baseUrl !== settings.baseUrl ||
		runtime.cookieSecret !== settings.cookieSecret
	) {
		const database = getSql(databaseUrl);
		runtime = {
			databaseUrl,
			baseUrl: settings.baseUrl,
			cookieSecret: settings.cookieSecret,
			auth: createAuthRuntime(database, settings),
			traces: new PostgresTraceReadRepository(database),
		};
	}
	const active = runtime;

	return createTraceReadRoutes({
		resolveScope: () =>
			resolveCallerScope({
				session: active.auth.session,
				memberships: active.auth.memberships,
				preferredOrganizationId: readActiveOrganizationPreference(),
			}),
		traces: active.traces,
	});
}

/** Test-only seam: drop the process-local bundle. */
export function resetTraceReadForTests(): void {
	runtime = undefined;
	sql = undefined;
	sqlUrl = undefined;
}

/**
 * Route module adapter. Configuration, auth and database failures all collapse
 * to one fixed 503; the route file stays a one-liner.
 */
export async function handleTaskTraceRoute(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): Promise<Response> {
	try {
		return await getTraceReadRoutes(env).get(request);
	} catch {
		return unavailable();
	}
}
