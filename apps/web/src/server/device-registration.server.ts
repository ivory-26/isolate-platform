import "@tanstack/react-start/server-only";
import {
	type ConnectorDeviceRepository,
	createDb,
	hasCapability,
	type PgSql,
	type PlatformCapability,
	PostgresConnectorDeviceRepository,
	PostgresRateLimitRepository,
	type UserRole,
} from "@isolate/db";
import {
	generateConnectorDeviceToken,
	hashConnectorDeviceToken,
} from "@isolate/integrations";
import {
	type ConnectorDeviceSummary,
	connectorDisplayNameSchema,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { readActiveOrganizationPreference } from "./active-organization.server";
import { type AuthRuntime, createAuthRuntime } from "./auth-runtime.server";
import { resolveCallerScope } from "./caller-scope.server";
import {
	DeviceGatewayNotConfiguredError,
	isDeviceGatewayEnabled,
} from "./device-gateway.server";
import { readNeonAuthSettings } from "./neon-auth.server";
import {
	createUserRateLimitGate,
	RateLimitExceededError,
	rateLimitedResponse,
	type UserRateLimitAction,
	type UserRateLimitGate,
} from "./rate-limit.server";
import {
	assertJsonRequest,
	assertSameOrigin,
	RequestGuardError,
} from "./request-guard.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

/**
 * Owner/admin device registration (W17).
 *
 * A signed-in caller with `member:manage` registers a device. The server
 * generates the 256-bit device token, stores only its sha256 hex digest in
 * `connector_devices.token_hash` and returns the plaintext token exactly once.
 * The token is never logged, persisted server-side or echoed in an error; no
 * other response carries it.
 *
 * The endpoint is disabled unless `DEVICE_GATEWAY_ENABLED` is exactly `true`
 * (after trim), so a deployment that has not opted into the device gateway
 * answers a fixed 503. A missing database is the same 503. Every failure body
 * is fixed text: no request payload, repository message or token is serialized.
 */

export const DEVICE_REGISTRATION_MAX_BODY_BYTES = 4 * 1024;

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

export const registerDeviceSchema = z.strictObject({
	displayName: connectorDisplayNameSchema,
});

export const revokeDeviceSchema = z.strictObject({
	deviceId: z.uuid(),
});

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
export type RevokeDeviceInput = z.infer<typeof revokeDeviceSchema>;

/** Returned once, on the registration response only. */
export type RegisteredDevice = {
	readonly deviceId: string;
	readonly token: string;
	/** ISO expiry; the device must rotate before this instant. */
	readonly expiresAt: string;
};

/** Default device-token lifetime; a rotation endpoint replaces the token. */
export const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Tenant-scoped device view: no token, no hash, no user/org ids. */
export type DeviceView = {
	readonly id: string;
	readonly displayName: string;
	readonly status: ConnectorDeviceSummary["status"];
	readonly lastSeenAt: string | null;
};

export type RevokedDevice = {
	readonly deviceId: string;
	readonly status: "revoked";
};

export type DeviceRegistrationDependencies = {
	/** Trusted server-side caller identity; never request data. */
	resolveScope: () => Promise<CallerScope>;
	devices: ConnectorDeviceRepository;
	/** Test seam only; production always uses `generateConnectorDeviceToken`. */
	generateToken?: () => string;
	/**
	 * Per-user throttle, applied after the scope and role are known. Production
	 * wiring always supplies it; a missing gate is the offline/test shape.
	 */
	rateLimiter?: UserRateLimitGate;
};

export type DeviceRegistrationService = {
	register(input: unknown): Promise<RegisteredDevice>;
	list(): Promise<DeviceView[]>;
	revoke(input: unknown): Promise<RevokedDevice>;
};

function validationError(): PlatformError {
	return new PlatformError("VALIDATION_FAILED", "device request is invalid");
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

async function scoped(
	dependencies: DeviceRegistrationDependencies,
	capability: PlatformCapability,
): Promise<CallerScope> {
	const scope = await dependencies.resolveScope();
	return requireScope(scope, capability);
}

/** Consumes the caller's per-user bucket for this action, if one is wired. */
async function throttled(
	dependencies: DeviceRegistrationDependencies,
	scope: CallerScope,
	action: UserRateLimitAction,
): Promise<void> {
	if (dependencies.rateLimiter === undefined) return;
	await dependencies.rateLimiter.enforce(scope.userId, action);
}

function toDeviceView(device: ConnectorDeviceSummary): DeviceView {
	return {
		id: device.id,
		displayName: device.displayName,
		status: device.status,
		lastSeenAt:
			device.lastSeenAt === null ? null : device.lastSeenAt.toISOString(),
	};
}

/**
 * Pure service over an injected repository and scope resolver. Errors are
 * `ControlPlaneError` (AUTH_REQUIRED/FORBIDDEN) or `PlatformError`
 * (VALIDATION_FAILED/NOT_FOUND/DB_UNAVAILABLE); the route adapter maps them to
 * fixed responses and never forwards a message.
 */
export function createDeviceRegistrationService(
	dependencies: DeviceRegistrationDependencies,
): DeviceRegistrationService {
	const generateToken =
		dependencies.generateToken ?? generateConnectorDeviceToken;

	return {
		async register(input) {
			const parsed = registerDeviceSchema.safeParse(input);
			if (!parsed.success) throw validationError();
			// Capability is checked before a token exists or storage is touched.
			const scope = await scoped(dependencies, "member:manage");
			await throttled(dependencies, scope, "device:register");
			const token = generateToken();
			const tokenHash = hashConnectorDeviceToken(token);
			const expiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_MS);
			const created = await dependencies.devices.create({
				organizationId: scope.organizationId,
				userId: scope.userId,
				displayName: parsed.data.displayName,
				tokenHash,
				status: "active",
				expiresAt,
			});
			// The only place the plaintext token ever leaves the service.
			return {
				deviceId: created.id,
				token,
				expiresAt: expiresAt.toISOString(),
			};
		},

		async list() {
			const scope = await scoped(dependencies, "organization:read");
			await throttled(dependencies, scope, "device:list");
			const devices = await dependencies.devices.listByOrganization(
				scope.organizationId,
			);
			return devices.map(toDeviceView);
		},

		async revoke(input) {
			const parsed = revokeDeviceSchema.safeParse(input);
			if (!parsed.success) throw validationError();
			const scope = await scoped(dependencies, "member:manage");
			await throttled(dependencies, scope, "device:revoke");
			const revoked = await dependencies.devices.revoke(
				scope.organizationId,
				parsed.data.deviceId.toLowerCase(),
			);
			// A foreign-tenant row is indistinguishable from a missing one.
			if (revoked === null) {
				throw new PlatformError("NOT_FOUND", "device not found");
			}
			// `status = 'revoked'` is written unconditionally, so a replay answers
			// 200 with the same body and changes nothing.
			return { deviceId: revoked.id, status: "revoked" };
		},
	};
}

function json(status: number, body: unknown): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

function fixedError(status: number, error: string): Response {
	return json(status, { error });
}

function invalidRequest(): Response {
	return fixedError(400, "device request is invalid");
}

function methodNotAllowed(): Response {
	return fixedError(405, "method not allowed");
}

function unavailable(): Response {
	return fixedError(503, "device registration is unavailable");
}

/** Maps a service failure to fixed text; never serializes the thrown value. */
function failureResponse(error: unknown): Response {
	if (error instanceof RequestGuardError) {
		return fixedError(error.status, "request rejected");
	}
	if (error instanceof RateLimitExceededError) {
		return rateLimitedResponse(error.retryAfterSeconds);
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
				return invalidRequest();
			case "NOT_FOUND":
				return fixedError(404, "device not found");
			default:
				break;
		}
	}
	// A driver/connection failure is a 503, never a 500 that leaks a driver
	// message.
	return unavailable();
}

async function readBoundedJson(request: Request): Promise<unknown> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (
			Number.isFinite(length) &&
			length > DEVICE_REGISTRATION_MAX_BODY_BYTES
		) {
			throw validationError();
		}
	}
	if (request.body === null) throw validationError();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let finished = false;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) {
				finished = true;
				break;
			}
			total += next.value.byteLength;
			if (total > DEVICE_REGISTRATION_MAX_BODY_BYTES) {
				throw validationError();
			}
			chunks.push(next.value);
		}
	} finally {
		if (!finished) await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw validationError();
	}
	if (text.trim().length === 0) throw validationError();
	try {
		return JSON.parse(text);
	} catch {
		throw validationError();
	}
}

export type DeviceRegistrationRoutes = {
	register(request: Request): Promise<Response>;
	list(request: Request): Promise<Response>;
	revoke(request: Request): Promise<Response>;
};

/** Route adapters over the pure service; every response is no-store. */
export function createDeviceRegistrationRoutes(
	dependencies: DeviceRegistrationDependencies,
): DeviceRegistrationRoutes {
	const service = createDeviceRegistrationService(dependencies);

	return {
		async register(request) {
			if (request.method !== "POST") return methodNotAllowed();
			try {
				assertSameOrigin(request);
				assertJsonRequest(request);
				const input = await readBoundedJson(request);
				return json(200, await service.register(input));
			} catch (error) {
				return failureResponse(error);
			}
		},

		async list(request) {
			if (request.method !== "GET") return methodNotAllowed();
			try {
				assertSameOrigin(request);
				return json(200, { devices: await service.list() });
			} catch (error) {
				return failureResponse(error);
			}
		},

		async revoke(request) {
			if (request.method !== "POST") return methodNotAllowed();
			try {
				assertSameOrigin(request);
				assertJsonRequest(request);
				const input = await readBoundedJson(request);
				return json(200, await service.revoke(input));
			} catch (error) {
				return failureResponse(error);
			}
		},
	};
}

type DeviceRegistrationRuntime = {
	databaseUrl: string;
	baseUrl: string;
	cookieSecret: string;
	auth: AuthRuntime;
	devices: ConnectorDeviceRepository;
	rateLimits: PostgresRateLimitRepository;
};

let sql: PgSql | undefined;
let sqlUrl: string | undefined;
let runtime: DeviceRegistrationRuntime | undefined;

function getSql(databaseUrl: string): PgSql {
	if (sql === undefined || sqlUrl !== databaseUrl) {
		sql = createDb(databaseUrl);
		sqlUrl = databaseUrl;
	}
	return sql;
}

/**
 * Production wiring: the device gateway switch, the database and the Neon Auth
 * session/membership readers. Missing config fails closed before any query.
 */
export function getDeviceRegistrationRoutes(
	env: Record<string, string | undefined> = process.env,
): DeviceRegistrationRoutes {
	if (!isDeviceGatewayEnabled(env)) {
		throw new DeviceGatewayNotConfiguredError();
	}
	const databaseUrl = env.DATABASE_URL?.trim();
	if (databaseUrl === undefined || databaseUrl.length === 0) {
		throw new DeviceGatewayNotConfiguredError();
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
			devices: new PostgresConnectorDeviceRepository(database),
			rateLimits: new PostgresRateLimitRepository(database),
		};
	}
	const active = runtime;

	return createDeviceRegistrationRoutes({
		resolveScope: () =>
			resolveCallerScope({
				session: active.auth.session,
				memberships: active.auth.memberships,
				preferredOrganizationId: readActiveOrganizationPreference(),
			}),
		devices: active.devices,
		rateLimiter: createUserRateLimitGate(active.rateLimits),
	});
}

/** Test-only seam: drop the process-local bundle. */
export function resetDeviceRegistrationForTests(): void {
	runtime = undefined;
	sql = undefined;
	sqlUrl = undefined;
}

/*
 * Route module adapters. Configuration and database failures collapse to one
 * fixed 503; the route files stay one-liners.
 */

export async function handleDeviceRegisterRoute(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): Promise<Response> {
	try {
		return await getDeviceRegistrationRoutes(env).register(request);
	} catch {
		return unavailable();
	}
}

export async function handleDeviceListRoute(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): Promise<Response> {
	try {
		return await getDeviceRegistrationRoutes(env).list(request);
	} catch {
		return unavailable();
	}
}

export async function handleDeviceRevokeRoute(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): Promise<Response> {
	try {
		return await getDeviceRegistrationRoutes(env).revoke(request);
	} catch {
		return unavailable();
	}
}
