import "@tanstack/react-start/server-only";
import {
	CONNECTOR_CALL_MAX_CLAIM_BATCH,
	CONNECTOR_CALL_MAX_PARAMS_BYTES,
	CONNECTOR_CALL_MAX_RESULT_BYTES,
	type ConnectorCallRecord,
	type ConnectorCallRepository,
	type ConnectorCredentialRepository,
	type ConnectorDeviceRepository,
	type ConnectorUsageLedgerRepository,
	createDb,
	normalizeBoundedConnectorJsonObject,
	type PgSql,
	PostgresConnectorCallRepository,
	PostgresConnectorCredentialRepository,
	PostgresConnectorDeviceRepository,
	PostgresConnectorUsageLedgerRepository,
	PostgresRateLimitRepository,
} from "@isolate/db";
import {
	DEVICE_PROXY_ERROR_CODES,
	hashConnectorDeviceToken,
} from "@isolate/integrations";
import {
	type ConnectorDeviceSummary,
	connectorCredentialRefSchema,
	connectorIdSchema,
	type OrganizationId,
	PlatformError,
} from "@isolate/shared";
import {
	DEVICE_CLAIM_RATE_LIMIT,
	DEVICE_HEARTBEAT_RATE_LIMIT,
	DEVICE_IP_RATE_LIMIT,
	DEVICE_RESULT_RATE_LIMIT,
	type DeviceRateLimitAction,
	deviceIpRateLimitKey,
	deviceRateLimitKey,
	enforceRateLimit,
	isTrustProxyHeadersEnabled,
	RATE_LIMIT_WINDOW_SECONDS,
	type RateLimitCounter,
	readClientIp,
} from "./rate-limit.server";

/**
 * Device daemon poll transport.
 *
 * The worker enqueues a typed connector call; the user's device polls
 * `/api/device/claim`, executes against the provider locally (its own keychain
 * item, its own network egress) and posts a bounded result. The server never
 * receives a provider key: it stores only the sha256 device token hash, opaque
 * credential metadata and bounded tool arguments.
 *
 * Authentication is `Authorization: Bearer <device token>`. The presented token
 * is hashed, resolved to a tenant through an index lookup and then re-verified
 * in constant time by `ConnectorDeviceRepository.verifyByTokenHash`. Missing,
 * malformed, unknown, pending and revoked tokens are all a generic 401; no
 * response ever echoes the token, the body or a database value.
 *
 * `DEVICE_GATEWAY_ENABLED` must be exactly `true` (after trim) or the runtime
 * refuses to build. Failure is a 503, never an open endpoint.
 */

export const DEVICE_GATEWAY_ENABLED_VARIABLE = "DEVICE_GATEWAY_ENABLED";
export const DEVICE_GATEWAY_MAX_RESULT_BODY_BYTES = 256 * 1024;
export const DEVICE_GATEWAY_MAX_CLAIM_PARAMS_BYTES =
	CONNECTOR_CALL_MAX_PARAMS_BYTES;
/** `?limit=` for a batched claim: 1–10, default 1 (existing contract). */
export const DEVICE_CLAIM_DEFAULT_LIMIT = 1;
export const DEVICE_CLAIM_MAX_LIMIT = CONNECTOR_CALL_MAX_CLAIM_BATCH;

const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;
/** At most one `last_seen_at` write per device per minute. */
const TOUCH_SEEN_INTERVAL_MS = 60_000;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DEVICE_RESULT_ERROR_CODES: ReadonlySet<string> = new Set(
	DEVICE_PROXY_ERROR_CODES,
);
const NO_STORE = { "cache-control": "no-store" } as const;

export class DeviceGatewayNotConfiguredError extends Error {
	constructor() {
		super("device gateway is not configured");
		this.name = "DeviceGatewayNotConfiguredError";
	}
}

export class DeviceGatewayBodyTooLargeError extends Error {
	constructor() {
		super("device request body is too large");
		this.name = "DeviceGatewayBodyTooLargeError";
	}
}

/** Test/ops visibility only; never true by default. */
export function isDeviceGatewayEnabled(
	env: Record<string, string | undefined>,
): boolean {
	const value = env[DEVICE_GATEWAY_ENABLED_VARIABLE];
	return value !== undefined && value.trim().toLowerCase() === "true";
}

/**
 * Index lookup from token hash to the owning tenant. The authoritative check is
 * still `verifyByTokenHash`; this only avoids a cross-tenant table scan.
 */
export type DeviceTokenHashLookup = (
	tokenHash: string,
) => Promise<{ organizationId: OrganizationId } | null>;

export type DeviceGatewayDependencies = {
	devices: ConnectorDeviceRepository;
	credentials: ConnectorCredentialRepository;
	calls: ConnectorCallRepository;
	/**
	 * Durable free-tier counter. When present, one unit is consumed before a
	 * call is handed to a device; an exhausted budget fails the call instead of
	 * silently overaging the provider's free plan.
	 */
	usage?: Pick<ConnectorUsageLedgerRepository, "consume">;
	/** Platform guard when the credential has no `requestsPerDay`. */
	freeDailyLimit?: number;
	lookupTokenHash: DeviceTokenHashLookup;
	/**
	 * Durable throttling (migration 0012). The pre-auth IP bucket runs before any
	 * token work; the per-device buckets run after authentication.
	 */
	rateLimits: RateLimitCounter;
	/** Read `x-forwarded-for` only behind a proxy that overwrites it. */
	trustProxyHeaders?: boolean;
	now?: () => Date;
};

const DEFAULT_FREE_DAILY_LIMIT = 1000;
const MAX_FREE_DAILY_LIMIT = 1_000_000;

function resolveDailyLimit(
	freeTierRequestsPerDay: number | null | undefined,
	fallback: number | undefined,
): number {
	if (
		typeof freeTierRequestsPerDay === "number" &&
		Number.isSafeInteger(freeTierRequestsPerDay) &&
		freeTierRequestsPerDay >= 0 &&
		freeTierRequestsPerDay <= MAX_FREE_DAILY_LIMIT
	) {
		return freeTierRequestsPerDay;
	}
	if (
		typeof fallback === "number" &&
		Number.isSafeInteger(fallback) &&
		fallback > 0 &&
		fallback <= MAX_FREE_DAILY_LIMIT
	) {
		return fallback;
	}
	return DEFAULT_FREE_DAILY_LIMIT;
}

export type DeviceGateway = {
	handleClaim(request: Request): Promise<Response>;
	handleResult(request: Request): Promise<Response>;
	handleHeartbeat(request: Request): Promise<Response>;
};

type AuthenticatedDevice = {
	device: ConnectorDeviceSummary;
	organizationId: OrganizationId;
};

function response(status: number, body: unknown): Response {
	return Response.json(body, {
		status,
		headers: NO_STORE,
	});
}

function unauthorized(): Response {
	return response(401, { error: "device authentication failed" });
}

function unavailable(): Response {
	return response(503, { error: "device gateway is unavailable" });
}

function invalidRequest(): Response {
	return response(400, { error: "device request is invalid" });
}

function tooLarge(): Response {
	return response(413, { error: "device request is too large" });
}

function callNotFound(): Response {
	return response(404, { error: "connector call not found" });
}

function callNotClaimed(): Response {
	return response(409, { error: "connector call is not claimed" });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function readBearerToken(headers: Headers): string | null {
	const raw = headers.get("authorization");
	if (raw === null) return null;
	const match = BEARER_PATTERN.exec(raw.trim());
	return match === null ? null : match[1];
}

/** Reads the body with both a declared-length and a streamed-bytes cap. */
async function readBoundedBody(
	request: Request,
	maxBytes: number,
): Promise<string> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > maxBytes) {
			throw new DeviceGatewayBodyTooLargeError();
		}
	}
	if (request.body === null) return "";
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
			if (total > maxBytes) throw new DeviceGatewayBodyTooLargeError();
			chunks.push(next.value);
		}
	} finally {
		if (!finished) await reader.cancel().catch(() => undefined);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(body);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "body is not UTF-8");
	}
}

/** `POST /api/device/calls/{id}/result` — id is the penultimate path segment. */
export function readDeviceCallId(request: Request): string | null {
	let segments: string[];
	try {
		segments = new URL(request.url).pathname.split("/").filter(Boolean);
	} catch {
		return null;
	}
	const index = segments.lastIndexOf("calls");
	if (index < 0 || index + 2 >= segments.length) return null;
	if (segments[index + 2] !== "result") return null;
	const candidate = segments[index + 1];
	if (candidate === undefined || !UUID_PATTERN.test(candidate)) return null;
	return candidate.toLowerCase();
}

const CLAIM_LIMIT_PATTERN = /^[0-9]{1,2}$/;

/**
 * `?limit=` is a bounded batch size: absent is 1 (the single-call contract),
 * anything not a whole number in 1..10 is a 400 rather than a silent clamp, so
 * a daemon bug is visible instead of quietly changing how much work it takes.
 */
export function readDeviceClaimLimit(request: Request): number | null {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return null;
	}
	const raw = url.searchParams.get("limit");
	if (raw === null) return DEVICE_CLAIM_DEFAULT_LIMIT;
	if (!CLAIM_LIMIT_PATTERN.test(raw)) return null;
	const value = Number(raw);
	if (value < 1 || value > DEVICE_CLAIM_MAX_LIMIT) return null;
	return value;
}

type ParsedResult =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; errorCode: string };

/**
 * Strict result envelope: `{ ok: true, data }` or `{ ok: false, errorCode }`.
 * Extra keys, non-object data, unknown error codes and credential-shaped text
 * are all rejected with fixed text.
 */
export function parseDeviceResultBody(text: string): ParsedResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "result body is not JSON");
	}
	if (!isPlainObject(parsed)) {
		throw new PlatformError("VALIDATION_FAILED", "result body is invalid");
	}
	const keys = Object.keys(parsed).sort();
	if (
		parsed.ok === true &&
		keys.length === 2 &&
		keys[0] === "data" &&
		keys[1] === "ok"
	) {
		return {
			ok: true,
			data: normalizeBoundedConnectorJsonObject(
				parsed.data,
				"connector call result",
				CONNECTOR_CALL_MAX_RESULT_BYTES,
			),
		};
	}
	if (
		parsed.ok === false &&
		keys.length === 2 &&
		keys[0] === "errorCode" &&
		keys[1] === "ok" &&
		typeof parsed.errorCode === "string" &&
		ERROR_CODE_PATTERN.test(parsed.errorCode) &&
		DEVICE_RESULT_ERROR_CODES.has(parsed.errorCode)
	) {
		return { ok: false, errorCode: parsed.errorCode };
	}
	throw new PlatformError("VALIDATION_FAILED", "result body is invalid");
}

function claimPayload(call: ConnectorCallRecord, credentialRef: string) {
	const params = normalizeBoundedConnectorJsonObject(
		call.params,
		"connector call params",
		DEVICE_GATEWAY_MAX_CLAIM_PARAMS_BYTES,
	);
	const ref = connectorCredentialRefSchema.safeParse(credentialRef);
	if (!ref.success || !connectorIdSchema.safeParse(call.connectorId).success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"connector call metadata is invalid",
		);
	}
	return {
		id: call.id,
		connectorId: call.connectorId,
		credentialRef: ref.data,
		toolName: call.toolName,
		params,
		traceparent: call.traceparent,
		deadlineAt: call.expiresAt.toISOString(),
	};
}

export function createDeviceGateway(
	dependencies: DeviceGatewayDependencies,
): DeviceGateway {
	const now = dependencies.now ?? (() => new Date());
	const trustProxy = dependencies.trustProxyHeaders === true;

	const authenticate = async (
		request: Request,
	): Promise<AuthenticatedDevice | null> => {
		const token = readBearerToken(request.headers);
		if (token === null) return null;
		let tokenHash: string;
		try {
			tokenHash = hashConnectorDeviceToken(token);
		} catch {
			return null;
		}
		const owner = await dependencies.lookupTokenHash(tokenHash);
		if (owner === null) return null;
		const device = await dependencies.devices.verifyByTokenHash(
			owner.organizationId,
			tokenHash,
		);
		if (device === null || device.status !== "active") return null;
		// Defense in depth: the repository filters expiry, and the gateway checks
		// the summary too, so a stale cache cannot authenticate.
		if (
			device.expiresAt !== null &&
			device.expiresAt.getTime() <= now().getTime()
		) {
			return null;
		}
		// Throttle the last-seen write: at most one per device per interval, so a
		// polling loop cannot amplify into a write per request.
		if (
			device.lastSeenAt === null ||
			now().getTime() - device.lastSeenAt.getTime() >= TOUCH_SEEN_INTERVAL_MS
		) {
			await dependencies.devices.touchSeen(
				device.organizationId,
				device.id,
				now(),
			);
		}
		return { device, organizationId: device.organizationId };
	};

	/**
	 * Pre-auth bucket, one per client address (or one shared bucket when proxy
	 * headers are not trusted). Runs before a token is even hashed, so a flood
	 * of bogus tokens never reaches the device table.
	 */
	const enforceIpLimit = (request: Request): Promise<Response | null> =>
		enforceRateLimit({
			limiter: dependencies.rateLimits,
			key: deviceIpRateLimitKey(readClientIp(request, trustProxy)),
			limit: DEVICE_IP_RATE_LIMIT,
			windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
		});

	const enforceDeviceLimit = (
		deviceId: string,
		action: DeviceRateLimitAction,
		limit: number,
	): Promise<Response | null> =>
		enforceRateLimit({
			limiter: dependencies.rateLimits,
			key: deviceRateLimitKey(deviceId, action),
			limit,
			windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
		});

	return {
		async handleClaim(request) {
			const ipDenied = await enforceIpLimit(request);
			if (ipDenied !== null) return ipDenied;
			const auth = await authenticate(request);
			if (auth === null) return unauthorized();
			const limit = readDeviceClaimLimit(request);
			if (limit === null) return invalidRequest();
			const denied = await enforceDeviceLimit(
				auth.device.id,
				"claim",
				DEVICE_CLAIM_RATE_LIMIT,
			);
			if (denied !== null) return denied;

			// The claim is already scoped to this device; every row still has to
			// pass the same tenant, credential and free-tier checks as a single
			// claim, and a row that fails is failed (never handed out).
			const calls = await dependencies.calls.claimNext(auth.device.id, limit);
			const payloads: ReturnType<typeof claimPayload>[] = [];
			for (const call of calls) {
				if (call.organizationId !== auth.organizationId) {
					// Defense in depth: a cross-tenant row is never handed to a device.
					await dependencies.calls.fail({
						callId: call.id,
						deviceId: auth.device.id,
						errorCode: "VALIDATION_FAILED",
					});
					continue;
				}
				const credential = await dependencies.credentials.get(
					auth.organizationId,
					call.credentialId,
				);
				try {
					if (
						credential === null ||
						credential.deviceId !== auth.device.id ||
						credential.organizationId !== auth.organizationId ||
						credential.status !== "active"
					) {
						throw new PlatformError(
							"INTEGRATION_UNAVAILABLE",
							"connector credential is unavailable",
						);
					}
					if (dependencies.usage !== undefined) {
						// The platform guard is server-side: a client-supplied
						// freeTierProfile must not raise the budget.
						const freeLimit = resolveDailyLimit(
							null,
							dependencies.freeDailyLimit,
						);
						const period = now().toISOString().slice(0, 10);
						const consumed = await dependencies.usage.consume(credential.id, {
							limitPerPeriod: freeLimit,
							period,
						});
						if (!consumed.consumed) {
							throw new PlatformError(
								"RATE_LIMITED",
								"connector free-tier budget exhausted",
							);
						}
					}
					payloads.push(claimPayload(call, credential.credentialRef));
				} catch (error) {
					// The call cannot be executed without leaking or trusting bad data.
					await dependencies.calls.fail({
						callId: call.id,
						deviceId: auth.device.id,
						errorCode:
							error instanceof PlatformError &&
							(error.code === "INTEGRATION_UNAVAILABLE" ||
								error.code === "RATE_LIMITED")
								? error.code
								: "VALIDATION_FAILED",
					});
				}
			}
			// A `?limit=1` (or absent) request keeps the single-call envelope so
			// existing daemons do not change; a batch request always gets `calls`.
			return limit === DEVICE_CLAIM_DEFAULT_LIMIT
				? response(200, { call: payloads[0] ?? null })
				: response(200, { calls: payloads });
		},

		async handleResult(request) {
			const ipDenied = await enforceIpLimit(request);
			if (ipDenied !== null) return ipDenied;
			const auth = await authenticate(request);
			if (auth === null) return unauthorized();
			const denied = await enforceDeviceLimit(
				auth.device.id,
				"result",
				DEVICE_RESULT_RATE_LIMIT,
			);
			if (denied !== null) return denied;
			const callId = readDeviceCallId(request);
			if (callId === null) return callNotFound();

			let text: string;
			try {
				text = await readBoundedBody(
					request,
					DEVICE_GATEWAY_MAX_RESULT_BODY_BYTES,
				);
			} catch (error) {
				if (error instanceof DeviceGatewayBodyTooLargeError) return tooLarge();
				if (error instanceof PlatformError) return invalidRequest();
				throw error;
			}
			let parsed: ParsedResult;
			try {
				parsed = parseDeviceResultBody(text);
			} catch {
				return invalidRequest();
			}

			const outcome = parsed.ok
				? await dependencies.calls.complete({
						callId,
						deviceId: auth.device.id,
						result: parsed.data,
					})
				: await dependencies.calls.fail({
						callId,
						deviceId: auth.device.id,
						errorCode: parsed.errorCode,
					});
			if (outcome.ok) return response(200, { ok: true });
			return outcome.code === "NOT_FOUND" ? callNotFound() : callNotClaimed();
		},

		async handleHeartbeat(request) {
			const ipDenied = await enforceIpLimit(request);
			if (ipDenied !== null) return ipDenied;
			const auth = await authenticate(request);
			if (auth === null) return unauthorized();
			const denied = await enforceDeviceLimit(
				auth.device.id,
				"heartbeat",
				DEVICE_HEARTBEAT_RATE_LIMIT,
			);
			if (denied !== null) return denied;
			return response(200, { ok: true });
		},
	};
}

let sql: PgSql | undefined;
let sqlUrl: string | undefined;
let gateway: DeviceGateway | undefined;

function getDatabase(databaseUrl: string): {
	devices: ConnectorDeviceRepository;
	credentials: ConnectorCredentialRepository;
	calls: ConnectorCallRepository;
	usage: ConnectorUsageLedgerRepository;
	rateLimits: PostgresRateLimitRepository;
	lookupTokenHash: DeviceTokenHashLookup;
} {
	if (sql === undefined || sqlUrl !== databaseUrl) {
		sql = createDb(databaseUrl);
		sqlUrl = databaseUrl;
	}
	const database = sql;
	return {
		devices: new PostgresConnectorDeviceRepository(database),
		credentials: new PostgresConnectorCredentialRepository(database),
		calls: new PostgresConnectorCallRepository(database),
		usage: new PostgresConnectorUsageLedgerRepository(database),
		rateLimits: new PostgresRateLimitRepository(database),
		lookupTokenHash: async (tokenHash) => {
			if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
			const rows = (await database.unsafe(
				`SELECT organization_id FROM connector_devices WHERE token_hash = $1`,
				[tokenHash],
			)) as unknown as Record<string, unknown>[];
			if (rows.length === 0) return null;
			return {
				organizationId: String(rows[0].organization_id) as OrganizationId,
			};
		},
	};
}

/**
 * Builds the route gateway from the environment. Disabled by default and
 * missing `DATABASE_URL` both fail closed with 503 at the route boundary.
 */
export function getDeviceGateway(
	env: Record<string, string | undefined> = process.env,
): DeviceGateway {
	if (!isDeviceGatewayEnabled(env)) {
		throw new DeviceGatewayNotConfiguredError();
	}
	const databaseUrl = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
		throw new DeviceGatewayNotConfiguredError();
	}
	if (gateway !== undefined && sqlUrl === databaseUrl) return gateway;
	const database = getDatabase(databaseUrl);
	const configured = Number(env.CONNECTOR_FREE_DAILY_CALLS?.trim() ?? "");
	gateway = createDeviceGateway({
		...database,
		trustProxyHeaders: isTrustProxyHeadersEnabled(env),
		...(Number.isSafeInteger(configured) && configured > 0
			? { freeDailyLimit: configured }
			: {}),
	});
	return gateway;
}

/** Test-only seam: reset the process-local bundle. */
export function resetDeviceGatewayForTests(): void {
	gateway = undefined;
	sql = undefined;
	sqlUrl = undefined;
}

/*
 * Route adapters. Every configuration or database failure collapses to a fixed
 * 503 with no-store headers; the route modules stay one-liners.
 */

export async function handleDeviceClaimRoute(
	request: Request,
): Promise<Response> {
	try {
		return await getDeviceGateway().handleClaim(request);
	} catch {
		return unavailable();
	}
}

export async function handleDeviceResultRoute(
	request: Request,
): Promise<Response> {
	try {
		return await getDeviceGateway().handleResult(request);
	} catch {
		return unavailable();
	}
}

export async function handleDeviceHeartbeatRoute(
	request: Request,
): Promise<Response> {
	try {
		return await getDeviceGateway().handleHeartbeat(request);
	} catch {
		return unavailable();
	}
}
