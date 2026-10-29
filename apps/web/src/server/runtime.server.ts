import "@tanstack/react-start/server-only";
import { createDb, type PgSql } from "@isolate/db";
import { createConsoleLogger } from "@isolate/shared";
import type { AuthState } from "../features/auth/contracts";
import {
	readActiveOrganizationPreference,
	writeActiveOrganizationPreference,
} from "./active-organization.server";
import { type AuthRuntime, createAuthRuntime } from "./auth-runtime.server";
import { createAuthService } from "./auth-service.server";
import {
	createLocalDemoAdapters,
	localDemoEnabled,
	type RuntimeConfig,
	resolveCallerScope,
} from "./caller-scope.server";
import {
	getNeonAuthServer,
	getRequestOrigin,
	type NeonAuthSettings,
	readNeonAuthSettings,
} from "./neon-auth.server";
import { createPostgresStore } from "./postgres-store.server";
import {
	type CallerScope,
	ControlPlaneError,
	createTaskService,
	type TaskStore,
} from "./task-service.server";

let store: Promise<TaskStore> | undefined;
let sql: PgSql | undefined;
let settings: NeonAuthSettings | null | undefined;
let authRuntime: AuthRuntime | undefined;

/** Server-side diagnostics for auth failures (stage + code only). */
const authLogger = createConsoleLogger("auth");

function getSql(databaseUrl: string): PgSql {
	sql ??= createDb(databaseUrl);
	return sql;
}

function getSettings(): NeonAuthSettings | null {
	if (settings === undefined) settings = readNeonAuthSettings(process.env);
	return settings;
}

/**
 * The authenticated runtime. A database deployment without a usable Neon Auth
 * configuration fails closed: headers, cookies and form fields are never
 * identity, so there is no demo tenant to fall back to.
 */
function getAuthRuntime(databaseUrl: string): AuthRuntime {
	const resolved = getSettings();
	if (!resolved) throw new ControlPlaneError("AUTH_REQUIRED");
	authRuntime ??= createAuthRuntime(getSql(databaseUrl), resolved);
	return authRuntime;
}

async function resolveRuntimeScope(
	config: RuntimeConfig,
): Promise<CallerScope> {
	if (!config.databaseUrl) {
		const adapters = createLocalDemoAdapters(config);
		return resolveCallerScope(adapters);
	}
	const runtime = getAuthRuntime(config.databaseUrl);
	return resolveCallerScope({
		session: runtime.session,
		memberships: runtime.memberships,
		preferredOrganizationId: readActiveOrganizationPreference(),
	});
}

export function getTaskService() {
	const config: RuntimeConfig = {
		nodeEnv: process.env.NODE_ENV,
		localDemo: process.env.WEB_LOCAL_DEMO,
		databaseUrl: process.env.DATABASE_URL,
	};
	return createTaskService({
		resolveScope: () => resolveRuntimeScope(config),
		getStore: () => {
			store ??= config.databaseUrl
				? Promise.resolve(createPostgresStore(getSql(config.databaseUrl)))
				: import("./development-store.server").then((module) =>
						module.createDevelopmentStore(config),
					);
			return store;
		},
	});
}

/**
 * Sign-in, sign-up and the session view. Available only when a database and a
 * Neon Auth configuration are both present.
 */
export function getAuthService() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new ControlPlaneError("AUTH_REQUIRED");
	const runtime = getAuthRuntime(databaseUrl);
	return createAuthService({
		server: getNeonAuthServer(runtime.settings),
		memberships: runtime.membershipRepository,
		organizations: runtime.organizationRepository,
		ensureTenancy: runtime.ensureTenancy,
		readActiveOrganization: readActiveOrganizationPreference,
		writeActiveOrganization: writeActiveOrganizationPreference,
		requestOrigin: getRequestOrigin,
		onUpstreamError: (event) => {
			// Stage + upstream code only: never a message, token or user data.
			authLogger.warn("neon auth call failed", event);
		},
	});
}

/**
 * The authentication posture of the running app.
 *
 * The answer is never derived from a request: it is the configured auth host
 * plus the session cookie. A deployment without a usable auth host reports
 * `unavailable` so every tenant route fails closed instead of serving data.
 */
export async function getAuthState(): Promise<AuthState> {
	const config: RuntimeConfig = {
		nodeEnv: process.env.NODE_ENV,
		localDemo: process.env.WEB_LOCAL_DEMO,
		databaseUrl: process.env.DATABASE_URL,
	};
	if (!config.databaseUrl) {
		return localDemoEnabled(config)
			? { mode: "demo" }
			: { mode: "unavailable" };
	}
	try {
		const session = await getAuthService().currentSession();
		return session.user
			? { mode: "authenticated", session }
			: { mode: "anonymous" };
	} catch {
		return { mode: "unavailable" };
	}
}

/**
 * The auth settings for the mounted proxy route. The proxy does not need a
 * session, but it still refuses to run without a configured auth host.
 */
export function getNeonAuthProxySettings(): NeonAuthSettings {
	const resolved = getSettings();
	if (!resolved) throw new ControlPlaneError("AUTH_REQUIRED");
	return resolved;
}
