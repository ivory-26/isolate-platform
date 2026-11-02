import "@tanstack/react-start/server-only";
import { createHash, randomBytes } from "node:crypto";
import {
	type ConnectorCredentialRepository,
	type ConnectorDeviceRepository,
	type ConnectorPairingRepository,
	type ConnectorPairingSummary,
	createDb,
	hasCapability,
	type PgSql,
	type PlatformCapability,
	PostgresConnectorCredentialRepository,
	PostgresConnectorDeviceRepository,
	PostgresConnectorPairingRepository,
	PostgresRateLimitRepository,
} from "@isolate/db";
import { hashConnectorDeviceToken } from "@isolate/integrations";
import {
	connectorAuthKindSchema,
	connectorDisplayNameSchema,
	connectorScopesSchema,
	type OrganizationId,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { readActiveOrganizationPreference } from "./active-organization.server";
import { createAuthRuntime } from "./auth-runtime.server";
import { resolveCallerScope } from "./caller-scope.server";
import {
	CONNECTOR_CONNECT_IDS,
	connectCredentialRefSchema,
	looksLikeCredentialSecret,
} from "./connector-connect.server";
import {
	DEVICE_GATEWAY_ENABLED_VARIABLE,
	isDeviceGatewayEnabled,
} from "./device-gateway.server";
import { readNeonAuthSettings } from "./neon-auth.server";
import {
	createUserRateLimitGate,
	RateLimitExceededError,
	rateLimitedResponse,
	type UserRateLimitGate,
} from "./rate-limit.server";
import {
	assertJsonRequest,
	assertSameOrigin,
	RequestGuardError,
} from "./request-guard.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

/**
 * Browser <-> relay pairing sessions (wave 23).
 *
 * A signed-in owner/admin creates a pairing for one relay and one connector.
 * The server generates a 256-bit code, stores only its sha256 hex digest and
 * returns the code and a `http://127.0.0.1:<port>/pair?code=...` URL once. The
 * relay claims the code with its own bearer token, serves a localhost form,
 * writes the provider secret to its encrypted local store and then completes
 * the pairing. The credential row it creates is metadata only; **no request or
 * response on this surface carries a provider secret.**
 *
 * Every device-authenticated route is a fixed 401 unless the presented bearer
 * token hashes to an active, unexpired device. Every session route is
 * capability-checked (owner/admin) and production-wired to Neon Auth. All
 * failures are fixed codes and messages; request values are never echoed. The
 * whole surface is disabled (fixed 503) unless `DEVICE_GATEWAY_ENABLED` is
 * exactly `true`.
 */

export const DEVICE_PAIRING_PATH = "/api/device/pairing";
export const DEVICE_PAIRING_LOCAL_HOST = "127.0.0.1";
export const DEVICE_PAIRING_LOCAL_PORT = 47821;
export const DEVICE_PAIRING_CODE_BYTES = 32;
export const DEVICE_PAIRING_CODE_CHARS = 43;
export const DEVICE_PAIRING_TTL_MS = 10 * 60 * 1000;
export const DEVICE_PAIRING_MAX_BODY_BYTES = 4 * 1024;

const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAIRING_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

const pairingIdSchema = z.uuid();

const createBodySchema = z.strictObject({
	relayId: z.uuid(),
	connectorId: z.enum(CONNECTOR_CONNECT_IDS),
	displayName: connectorDisplayNameSchema,
	authKind: connectorAuthKindSchema,
	credentialRef: connectCredentialRefSchema,
	scopes: connectorScopesSchema.optional(),
});

const claimBodySchema = z.strictObject({
	code: z.string().regex(PAIRING_CODE_PATTERN, "invalid pairing code"),
});

const completeBodySchema = z.strictObject({
	pairingId: pairingIdSchema,
});

const cancelBodySchema = z.strictObject({
	pairingId: pairingIdSchema,
});

const scopeShapeSchema = z.strictObject({
	organizationId: z.uuid(),
	userId: z.uuid(),
	role: z.enum(["owner", "admin", "member", "viewer"]),
});

export type DevicePairingCreateInput = z.input<typeof createBodySchema>;
export type DevicePairingClaimInput = z.input<typeof claimBodySchema>;
export type DevicePairingCompleteInput = z.input<typeof completeBodySchema>;
export type DevicePairingCancelInput = z.input<typeof cancelBodySchema>;

export const DEVICE_PAIRING_FAILURE_CODES = [
	"INVALID_INPUT",
	"AUTH_REQUIRED",
	"FORBIDDEN",
	"NOT_FOUND",
	"CONFLICT",
	"RATE_LIMITED",
	"UNAVAILABLE",
] as const;
export type DevicePairingFailureCode =
	(typeof DEVICE_PAIRING_FAILURE_CODES)[number];

/** Fixed, bounded text; no entry interpolates request or database data. */
export const DEVICE_PAIRING_FAILURE_MESSAGES: Record<
	DevicePairingFailureCode,
	string
> = {
	INVALID_INPUT: "The pairing request is invalid.",
	AUTH_REQUIRED: "Authentication is required to pair a connector.",
	FORBIDDEN:
		"This action requires an owner or admin role in this organization.",
	NOT_FOUND: "The pairing session or code was not found.",
	CONFLICT: "The pairing session is not in a state that allows this action.",
	RATE_LIMITED: "Too many pairing requests. Try again shortly.",
	UNAVAILABLE:
		"Connector pairing is not configured or is temporarily unavailable.",
};

export type DevicePairingResult<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly error: {
				readonly code: DevicePairingFailureCode;
				readonly message: string;
				readonly retryAfterSeconds?: number;
			};
	  };

export type PairingCreated = {
	readonly pairingId: string;
	readonly code: string;
	readonly localUrl: string;
	readonly expiresAt: string;
};

export type PairingStatusView = {
	readonly pairingId: string;
	readonly status: ConnectorPairingSummary["status"];
	readonly expiresAt: string;
	readonly credentialId?: string;
};

/**
 * Bounded metadata handed to a relay that won the code. It names the secret's
 * device-side slot; there is no secret field to send.
 */
export type PairingClaimView = {
	readonly pairingId: string;
	readonly relayId: string;
	readonly connectorId: string;
	readonly authKind: ConnectorPairingSummary["authKind"];
	readonly credentialRef: string;
	readonly displayName: string;
	readonly scopes: readonly string[];
	readonly expiresAt: string;
};

export type PairingCompleteView = {
	readonly credentialId: string;
	readonly status: "pending_validation";
};

export type PairingCancelledView = {
	readonly pairingId: string;
	readonly status: "cancelled";
};

export type AuthenticatedPairingDevice = {
	readonly deviceId: string;
	readonly organizationId: OrganizationId;
};

/** Trusted device identity for the bearer-authenticated routes. */
export type PairingDeviceAuthenticator = (
	request: Request,
) => Promise<AuthenticatedPairingDevice | null>;

export type DevicePairingDependencies = {
	devices: ConnectorDeviceRepository;
	credentials: ConnectorCredentialRepository;
	pairings: ConnectorPairingRepository;
	/** Trusted server-side user identity; never request data. */
	resolveScope: () => Promise<CallerScope>;
	/** Trusted server-side device identity from the bearer token. */
	authenticateDevice: PairingDeviceAuthenticator;
	/** Test seam only; production always uses the 256-bit generator. */
	generateCode?: () => string;
	now?: () => Date;
	rateLimiter?: UserRateLimitGate;
};

export type DevicePairingService = {
	create(input: unknown): Promise<DevicePairingResult<PairingCreated>>;
	status(pairingId: string): Promise<DevicePairingResult<PairingStatusView>>;
	cancel(input: unknown): Promise<DevicePairingResult<PairingCancelledView>>;
	claim(
		input: unknown,
		request: Request,
	): Promise<DevicePairingResult<PairingClaimView>>;
	complete(
		input: unknown,
		request: Request,
	): Promise<DevicePairingResult<PairingCompleteView>>;
};

/** Internal control-flow signal; maps to a fixed failure below. */
class PairingRefusal extends Error {
	constructor(readonly code: DevicePairingFailureCode) {
		super(code);
		this.name = "PairingRefusal";
	}
}

function failure<T>(
	code: DevicePairingFailureCode,
	retryAfterSeconds?: number,
): DevicePairingResult<T> {
	return {
		ok: false,
		error: {
			code,
			message: DEVICE_PAIRING_FAILURE_MESSAGES[code],
			...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		},
	};
}

function failureFromError<T>(error: unknown): DevicePairingResult<T> {
	if (error instanceof PairingRefusal) return failure(error.code);
	if (error instanceof RateLimitExceededError) {
		return failure("RATE_LIMITED", error.retryAfterSeconds);
	}
	if (error instanceof ControlPlaneError) {
		if (error.code === "AUTH_REQUIRED") return failure("AUTH_REQUIRED");
		if (error.code === "FORBIDDEN") return failure("FORBIDDEN");
		return failure("UNAVAILABLE");
	}
	if (error instanceof PlatformError) {
		if (error.code === "VALIDATION_FAILED") return failure("INVALID_INPUT");
		if (error.code === "NOT_FOUND") return failure("NOT_FOUND");
		return failure("UNAVAILABLE");
	}
	// Never serialize a driver error, a stack or request data.
	return failure("UNAVAILABLE");
}

/** sha256 hex of the one-time pairing code; the code never reaches storage. */
export function hashPairingCode(code: string): string {
	return createHash("sha256").update(code, "utf8").digest("hex");
}

/** 256 random bits as 43 base64url characters, no padding. */
export function generatePairingCode(): string {
	return randomBytes(DEVICE_PAIRING_CODE_BYTES).toString("base64url");
}

export function buildPairingLocalUrl(
	code: string,
	port: number = DEVICE_PAIRING_LOCAL_PORT,
): string {
	return `http://${DEVICE_PAIRING_LOCAL_HOST}:${port}/pair?code=${encodeURIComponent(code)}`;
}

function requestTextIsClean(input: {
	displayName: string;
	credentialRef: string;
	scopes: readonly string[];
}): boolean {
	if (looksLikeCredentialSecret(input.displayName)) return false;
	if (looksLikeCredentialSecret(input.credentialRef)) return false;
	return !input.scopes.some((scope) => looksLikeCredentialSecret(scope));
}

function credentialIdFromMetadata(
	metadata: Readonly<Record<string, unknown>>,
): string | null {
	const value = metadata.credentialId;
	return typeof value === "string" && pairingIdSchema.safeParse(value).success
		? value
		: null;
}

function isActiveDevice(
	device: { status: string; expiresAt: Date | null },
	now: Date,
): boolean {
	if (device.status !== "active") return false;
	return (
		device.expiresAt === null || device.expiresAt.getTime() > now.getTime()
	);
}

export function createDevicePairingService(
	dependencies: DevicePairingDependencies,
): DevicePairingService {
	const now = dependencies.now ?? (() => new Date());
	const generateCode = dependencies.generateCode ?? generatePairingCode;
	const localPort = DEVICE_PAIRING_LOCAL_PORT;

	const scoped = async <T>(
		capability: PlatformCapability | null,
		action: "connector:connect" | "connector:list" | "connector:revoke",
		handler: (scope: CallerScope, at: Date) => Promise<T>,
	): Promise<DevicePairingResult<T>> => {
		try {
			const scope = await dependencies.resolveScope();
			if (!scopeShapeSchema.safeParse(scope).success) {
				return failure("AUTH_REQUIRED");
			}
			if (capability !== null && !hasCapability(scope.role, capability)) {
				return failure("FORBIDDEN");
			}
			if (dependencies.rateLimiter !== undefined) {
				await dependencies.rateLimiter.enforce(scope.userId, action);
			}
			return { ok: true, value: await handler(scope, now()) };
		} catch (error) {
			return failureFromError(error);
		}
	};

	return {
		async create(input) {
			const parsed = createBodySchema.safeParse(input);
			if (!parsed.success) return failure("INVALID_INPUT");
			const body = parsed.data;
			return scoped("member:manage", "connector:connect", async (scope, at) => {
				if (
					!requestTextIsClean({
						displayName: body.displayName,
						credentialRef: body.credentialRef,
						scopes: body.scopes ?? [],
					})
				) {
					throw new PairingRefusal("INVALID_INPUT");
				}
				// Tenant-scoped read: a foreign or pending relay is a 404.
				const devices = await dependencies.devices.listByOrganization(
					scope.organizationId,
				);
				const relay = devices.find(
					(candidate) => candidate.id === body.relayId,
				);
				if (relay === undefined || !isActiveDevice(relay, at)) {
					throw new PairingRefusal("NOT_FOUND");
				}
				const code = generateCode();
				if (!PAIRING_CODE_PATTERN.test(code)) {
					// A broken generator is a server fault, never a weak code.
					throw new PairingRefusal("UNAVAILABLE");
				}
				const expiresAt = new Date(at.getTime() + DEVICE_PAIRING_TTL_MS);
				const pairing = await dependencies.pairings.create({
					organizationId: scope.organizationId,
					deviceId: body.relayId,
					connectorId: body.connectorId,
					displayName: body.displayName,
					authKind: body.authKind,
					credentialRef: body.credentialRef,
					scopes: body.scopes ?? [],
					codeHash: hashPairingCode(code),
					createdBy: scope.userId,
					expiresAt,
				});
				return {
					pairingId: pairing.id,
					code,
					localUrl: buildPairingLocalUrl(code, localPort),
					expiresAt: expiresAt.toISOString(),
				};
			});
		},

		async status(pairingId) {
			const parsed = pairingIdSchema.safeParse(pairingId);
			if (!parsed.success) return failure("INVALID_INPUT");
			return scoped(null, "connector:list", async (scope, at) => {
				const pairing = await dependencies.pairings.get(
					scope.organizationId,
					parsed.data,
				);
				if (pairing === null) throw new PairingRefusal("NOT_FOUND");
				let status = pairing.status;
				if (
					(status === "pending" || status === "claimed") &&
					pairing.expiresAt.getTime() <= at.getTime()
				) {
					const expired = await dependencies.pairings.expire(
						scope.organizationId,
						pairing.id,
						at,
					);
					status = expired?.status ?? "expired";
				}
				const credentialId = credentialIdFromMetadata(pairing.metadata);
				return {
					pairingId: pairing.id,
					status,
					expiresAt: pairing.expiresAt.toISOString(),
					...(credentialId === null ? {} : { credentialId }),
				};
			});
		},

		async cancel(input) {
			const parsed = cancelBodySchema.safeParse(input);
			if (!parsed.success) return failure("INVALID_INPUT");
			return scoped("member:manage", "connector:revoke", async (scope, at) => {
				const pairing = await dependencies.pairings.get(
					scope.organizationId,
					parsed.data.pairingId,
				);
				if (pairing === null) throw new PairingRefusal("NOT_FOUND");
				if (pairing.status === "cancelled") {
					return { pairingId: pairing.id, status: "cancelled" as const };
				}
				if (pairing.status !== "pending" && pairing.status !== "claimed") {
					throw new PairingRefusal("CONFLICT");
				}
				const cancelled = await dependencies.pairings.cancel(
					scope.organizationId,
					pairing.id,
					at,
				);
				if (cancelled === null) throw new PairingRefusal("CONFLICT");
				return { pairingId: cancelled.id, status: "cancelled" as const };
			});
		},

		async claim(input, request) {
			const parsed = claimBodySchema.safeParse(input);
			if (!parsed.success) return failure("INVALID_INPUT");
			try {
				const device = await dependencies.authenticateDevice(request);
				if (device === null) throw new PairingRefusal("AUTH_REQUIRED");
				const claimed = await dependencies.pairings.claimByCodeHash(
					device.organizationId,
					device.deviceId,
					hashPairingCode(parsed.data.code),
					now(),
				);
				// Wrong, expired, already-claimed and other-device codes are one 404.
				if (claimed === null) throw new PairingRefusal("NOT_FOUND");
				return {
					ok: true,
					value: {
						pairingId: claimed.id,
						relayId: claimed.deviceId,
						connectorId: claimed.connectorId,
						authKind: claimed.authKind,
						credentialRef: claimed.credentialRef,
						displayName: claimed.displayName,
						scopes: [...claimed.scopes],
						expiresAt: claimed.expiresAt.toISOString(),
					},
				};
			} catch (error) {
				return failureFromError(error);
			}
		},

		async complete(input, request) {
			const parsed = completeBodySchema.safeParse(input);
			if (!parsed.success) return failure("INVALID_INPUT");
			try {
				const device = await dependencies.authenticateDevice(request);
				if (device === null) throw new PairingRefusal("AUTH_REQUIRED");
				const pairing = await dependencies.pairings.get(
					device.organizationId,
					parsed.data.pairingId,
				);
				if (pairing === null || pairing.deviceId !== device.deviceId) {
					throw new PairingRefusal("NOT_FOUND");
				}
				const existing = credentialIdFromMetadata(pairing.metadata);
				// A replay answers with the same credential; nothing is written.
				if (pairing.status === "completed" && existing !== null) {
					return {
						ok: true,
						value: {
							credentialId: existing,
							status: "pending_validation",
						},
					};
				}
				if (pairing.status !== "claimed") throw new PairingRefusal("CONFLICT");

				let credentialId = existing;
				if (credentialId === null) {
					// Idempotency: reuse a row this relay already registered for the
					// same connector and device-side slot.
					const rows = await dependencies.credentials.listByOrganization(
						device.organizationId,
					);
					const reusable = rows.find(
						(row) =>
							row.deviceId === device.deviceId &&
							row.connectorId === pairing.connectorId &&
							row.credentialRef === pairing.credentialRef,
					);
					if (reusable !== undefined) {
						credentialId = reusable.id;
					} else {
						const created = await dependencies.credentials.create({
							organizationId: device.organizationId,
							deviceId: device.deviceId,
							connectorId: pairing.connectorId,
							displayName: pairing.displayName,
							authKind: pairing.authKind,
							credentialRef: pairing.credentialRef,
							scopes: [...pairing.scopes],
							status: "pending_validation",
							createdBy: pairing.createdBy,
						});
						credentialId = created.id;
					}
				}
				const completed = await dependencies.pairings.complete(
					device.organizationId,
					pairing.id,
					{ credentialId },
					now(),
				);
				if (completed === null) {
					// A concurrent completion won; answer with its credential id.
					const latest = await dependencies.pairings.get(
						device.organizationId,
						pairing.id,
					);
					const latestId =
						latest === null ? null : credentialIdFromMetadata(latest.metadata);
					if (latest?.status === "completed" && latestId !== null) {
						return {
							ok: true,
							value: {
								credentialId: latestId,
								status: "pending_validation",
							},
						};
					}
					throw new PairingRefusal("CONFLICT");
				}
				return {
					ok: true,
					value: { credentialId, status: "pending_validation" },
				};
			} catch (error) {
				return failureFromError(error);
			}
		},
	};
}

/*
 * Runtime wiring. Identity is never read from a request body: the caller scope
 * comes from the session resolver and the device identity from the bearer
 * token's hash. Missing configuration fails closed before any query.
 */

export class DevicePairingNotConfiguredError extends Error {
	constructor() {
		super("connector pairing is not configured");
		this.name = "DevicePairingNotConfiguredError";
	}
}

export type DevicePairingRouteOptions = {
	env?: Record<string, string | undefined>;
	service?: DevicePairingService;
};

const FAILURE_STATUS: Record<DevicePairingFailureCode, number> = {
	INVALID_INPUT: 400,
	AUTH_REQUIRED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	RATE_LIMITED: 429,
	UNAVAILABLE: 503,
};

export function readDevicePairingId(request: Request): string | null {
	let pathname: string;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		return null;
	}
	const match = /^\/api\/device\/pairing\/([0-9a-fA-F-]{36})$/.exec(pathname);
	if (match === null) return null;
	const id = match[1]?.toLowerCase() ?? "";
	return PAIRING_ID_PATTERN.test(id) ? id : null;
}

let sql: PgSql | undefined;
let sqlUrl: string | undefined;
let service: DevicePairingService | undefined;
let serviceKey: string | undefined;

function getDatabase(databaseUrl: string): PgSql {
	if (sql === undefined || sqlUrl !== databaseUrl) {
		sql = createDb(databaseUrl);
		sqlUrl = databaseUrl;
	}
	return sql;
}

/**
 * Production device authenticator: hash the presented bearer token, resolve its
 * tenant through an index lookup, then re-verify the hash in constant time.
 * Any failure is a null (a fixed 401 at the route), never a distinct error.
 */
function createDeviceAuthenticator(
	database: PgSql,
	devices: ConnectorDeviceRepository,
): PairingDeviceAuthenticator {
	return async (request) => {
		const raw = request.headers.get("authorization");
		if (raw === null) return null;
		const match = BEARER_PATTERN.exec(raw.trim());
		if (match === null) return null;
		const token = match[1];
		if (token === undefined) return null;
		let tokenHash: string;
		try {
			tokenHash = hashConnectorDeviceToken(token);
		} catch {
			return null;
		}
		const rows = (await database.unsafe(
			`SELECT organization_id FROM connector_devices WHERE token_hash = $1`,
			[tokenHash],
		)) as unknown as Record<string, unknown>[];
		if (rows.length === 0) return null;
		const organizationId = String(rows[0].organization_id) as OrganizationId;
		const device = await devices.verifyByTokenHash(organizationId, tokenHash);
		if (device === null || device.status !== "active") return null;
		if (device.expiresAt !== null && device.expiresAt.getTime() <= Date.now()) {
			return null;
		}
		return { deviceId: device.id, organizationId: device.organizationId };
	};
}

export function getDevicePairingService(
	env: Record<string, string | undefined> = process.env,
): DevicePairingService {
	if (!isDeviceGatewayEnabled(env)) {
		throw new DevicePairingNotConfiguredError();
	}
	const databaseUrl = env.DATABASE_URL?.trim();
	if (databaseUrl === undefined || databaseUrl.length === 0) {
		throw new DevicePairingNotConfiguredError();
	}
	const settings = readNeonAuthSettings(env);
	if (settings === null) throw new DevicePairingNotConfiguredError();
	const key = `${databaseUrl}\u0000${settings.baseUrl}`;
	if (service !== undefined && serviceKey === key) return service;

	const database = getDatabase(databaseUrl);
	const runtime = createAuthRuntime(database, settings);
	const devices = new PostgresConnectorDeviceRepository(database);
	service = createDevicePairingService({
		devices,
		credentials: new PostgresConnectorCredentialRepository(database),
		pairings: new PostgresConnectorPairingRepository(database),
		resolveScope: () =>
			resolveCallerScope({
				session: runtime.session,
				memberships: runtime.memberships,
				preferredOrganizationId: readActiveOrganizationPreference(),
			}),
		authenticateDevice: createDeviceAuthenticator(database, devices),
		rateLimiter: createUserRateLimitGate(
			new PostgresRateLimitRepository(database),
		),
	});
	serviceKey = key;
	return service;
}

/** Test-only seam: reset the process-local database/service bundle. */
export function resetDevicePairingForTests(): void {
	sql = undefined;
	sqlUrl = undefined;
	service = undefined;
	serviceKey = undefined;
}

/*
 * Route adapters. Every configuration, database or parse failure collapses to a
 * fixed response; the route modules stay one-liners.
 */

class PairingBodyTooLargeError extends Error {
	constructor() {
		super("pairing request body is too large");
		this.name = "PairingBodyTooLargeError";
	}
}

function json(status: number, body: unknown): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

function unavailable(): Response {
	return json(503, { error: DEVICE_PAIRING_FAILURE_MESSAGES.UNAVAILABLE });
}

function invalidInput(): Response {
	return json(400, { error: DEVICE_PAIRING_FAILURE_MESSAGES.INVALID_INPUT });
}

function methodNotAllowed(): Response {
	return json(405, { error: "method not allowed" });
}

function respond<T>(result: DevicePairingResult<T>): Response {
	if (result.ok) return json(200, result.value);
	if (result.error.code === "RATE_LIMITED") {
		return rateLimitedResponse(result.error.retryAfterSeconds ?? 0);
	}
	return json(FAILURE_STATUS[result.error.code], {
		error: result.error.message,
	});
}

function serviceFor(options: DevicePairingRouteOptions): DevicePairingService {
	if (options.service !== undefined) return options.service;
	return getDevicePairingService(options.env ?? process.env);
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
			throw new PairingBodyTooLargeError();
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
			if (total > maxBytes) throw new PairingBodyTooLargeError();
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
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readJsonBody(
	request: Request,
	maxBytes: number,
): Promise<unknown> {
	let text: string;
	try {
		text = await readBoundedBody(request, maxBytes);
	} catch (error) {
		if (error instanceof PairingBodyTooLargeError) throw error;
		throw new PairingRefusal("INVALID_INPUT");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new PairingRefusal("INVALID_INPUT");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new PairingRefusal("INVALID_INPUT");
	}
	return parsed;
}

async function parseRouteBody(request: Request): Promise<unknown> {
	return readJsonBody(request, DEVICE_PAIRING_MAX_BODY_BYTES);
}

function guardSessionRequest(request: Request): Response | null {
	try {
		assertSameOrigin(request);
		assertJsonRequest(request, { maxBytes: DEVICE_PAIRING_MAX_BODY_BYTES });
		return null;
	} catch (error) {
		if (error instanceof RequestGuardError) {
			return json(error.status, { error: "request rejected" });
		}
		return unavailable();
	}
}

function guardDeviceRequest(request: Request): Response | null {
	try {
		assertJsonRequest(request, { maxBytes: DEVICE_PAIRING_MAX_BODY_BYTES });
		return null;
	} catch (error) {
		if (error instanceof RequestGuardError) {
			return json(error.status, { error: "request rejected" });
		}
		return unavailable();
	}
}

export async function handleDevicePairingCreateRoute(
	request: Request,
	options: DevicePairingRouteOptions = {},
): Promise<Response> {
	let pairingService: DevicePairingService;
	try {
		pairingService = serviceFor(options);
	} catch {
		return unavailable();
	}
	if (request.method !== "POST") return methodNotAllowed();
	const guarded = guardSessionRequest(request);
	if (guarded !== null) return guarded;
	let body: unknown;
	try {
		body = await parseRouteBody(request);
	} catch (error) {
		if (error instanceof PairingBodyTooLargeError) {
			return json(413, { error: "The pairing request body is too large." });
		}
		return invalidInput();
	}
	try {
		return respond(await pairingService.create(body));
	} catch {
		return unavailable();
	}
}

export async function handleDevicePairingStatusRoute(
	request: Request,
	options: DevicePairingRouteOptions = {},
): Promise<Response> {
	let pairingService: DevicePairingService;
	try {
		pairingService = serviceFor(options);
	} catch {
		return unavailable();
	}
	if (request.method !== "GET") return methodNotAllowed();
	try {
		assertSameOrigin(request);
	} catch (error) {
		if (error instanceof RequestGuardError) {
			return json(error.status, { error: "request rejected" });
		}
		return unavailable();
	}
	const pairingId = readDevicePairingId(request);
	if (pairingId === null) return invalidInput();
	try {
		return respond(await pairingService.status(pairingId));
	} catch {
		return unavailable();
	}
}

export async function handleDevicePairingCancelRoute(
	request: Request,
	options: DevicePairingRouteOptions = {},
): Promise<Response> {
	let pairingService: DevicePairingService;
	try {
		pairingService = serviceFor(options);
	} catch {
		return unavailable();
	}
	if (request.method !== "POST") return methodNotAllowed();
	const guarded = guardSessionRequest(request);
	if (guarded !== null) return guarded;
	let body: unknown;
	try {
		body = await parseRouteBody(request);
	} catch (error) {
		if (error instanceof PairingBodyTooLargeError) {
			return json(413, { error: "The pairing request body is too large." });
		}
		return invalidInput();
	}
	try {
		return respond(await pairingService.cancel(body));
	} catch {
		return unavailable();
	}
}

export async function handleDevicePairingClaimRoute(
	request: Request,
	options: DevicePairingRouteOptions = {},
): Promise<Response> {
	let pairingService: DevicePairingService;
	try {
		pairingService = serviceFor(options);
	} catch {
		return unavailable();
	}
	if (request.method !== "POST") return methodNotAllowed();
	const guarded = guardDeviceRequest(request);
	if (guarded !== null) return guarded;
	let body: unknown;
	try {
		body = await parseRouteBody(request);
	} catch (error) {
		if (error instanceof PairingBodyTooLargeError) {
			return json(413, { error: "The pairing request body is too large." });
		}
		return invalidInput();
	}
	try {
		return respond(await pairingService.claim(body, request));
	} catch {
		return unavailable();
	}
}

export async function handleDevicePairingCompleteRoute(
	request: Request,
	options: DevicePairingRouteOptions = {},
): Promise<Response> {
	let pairingService: DevicePairingService;
	try {
		pairingService = serviceFor(options);
	} catch {
		return unavailable();
	}
	if (request.method !== "POST") return methodNotAllowed();
	const guarded = guardDeviceRequest(request);
	if (guarded !== null) return guarded;
	let body: unknown;
	try {
		body = await parseRouteBody(request);
	} catch (error) {
		if (error instanceof PairingBodyTooLargeError) {
			return json(413, { error: "The pairing request body is too large." });
		}
		return invalidInput();
	}
	try {
		return respond(await pairingService.complete(body, request));
	} catch {
		return unavailable();
	}
}

/** Environment variable name re-exported for ops visibility in tests/docs. */
export const DEVICE_PAIRING_GATE_VARIABLE = DEVICE_GATEWAY_ENABLED_VARIABLE;

/** Narrowing helper kept next to the routes for clarity in logs. */
export function isDevicePairingEnabled(
	env: Record<string, string | undefined>,
): boolean {
	return isDeviceGatewayEnabled(env) && (env.DATABASE_URL ?? "").trim() !== "";
}
