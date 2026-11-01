import "@tanstack/react-start/server-only";
import {
	type ConnectorCredentialRepository,
	type ConnectorDeviceRepository,
	createDb,
	hasCapability,
	type PgSql,
	type PlatformCapability,
	PostgresConnectorCredentialRepository,
	PostgresConnectorDeviceRepository,
	PostgresRateLimitRepository,
} from "@isolate/db";
import {
	type ConnectorCredentialSummary,
	connectorAuthKindSchema,
	connectorDisplayNameSchema,
	connectorScopesSchema,
	emptyFreeTierProfile,
	type FreeTierProfile,
	freeTierProfileSchema,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { readActiveOrganizationPreference } from "./active-organization.server";
import { createAuthRuntime } from "./auth-runtime.server";
import { resolveCallerScope } from "./caller-scope.server";
import {
	DEVICE_GATEWAY_ENABLED_VARIABLE,
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
import { type CallerScope, ControlPlaneError } from "./task-service.server";

/**
 * Metadata-only connector connect surface (wave 17).
 *
 * SECURITY: the provider secret never reaches this server. A connect request
 * names a device, a connector, an auth kind and an opaque `credential_ref`
 * (the device-side keychain item name); the daemon writes the secret to its
 * own keychain. The server stores no secret, ciphertext, wrapped key or token.
 *
 * The credential-ref boundary is deliberately strict: it must match an opaque
 * name pattern, and any value shaped like a vendor token (GitHub, Slack, AWS,
 * PEM private key) is refused before a repository write. Metadata, scopes and
 * the display name are scanned by the same detector, so a pasted secret cannot
 * ride along in a secondary field. Every rejection is fixed text; an input
 * value is never echoed.
 *
 * `DEVICE_GATEWAY_ENABLED=true` and a usable `DATABASE_URL` plus Neon Auth
 * configuration are required; anything missing is a fixed 503, never an open
 * endpoint.
 */

/** The ten connectors a tenant may connect (closed union, not free text). */
export const CONNECTOR_CONNECT_IDS = [
	"github",
	"sentry",
	"grafana",
	"pagerduty",
	"kubernetes",
	"datadog",
	"newrelic",
	"honeycomb",
	"axiom",
	"signoz",
] as const;
export type ConnectorConnectId = (typeof CONNECTOR_CONNECT_IDS)[number];

export const CONNECTOR_CONNECT_MAX_BODY_BYTES = 16 * 1024;
export const MAX_CREDENTIAL_REF_CHARS = 200;
/** A value longer than this is treated as material, never a name. */
export const MAX_SECRET_SCAN_CHARS = 256;

const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9._:/~-]+$/;
const METADATA_MAX_DEPTH = 5;
const METADATA_MAX_KEYS = 64;
const METADATA_MAX_ARRAY_ITEMS = 256;
const METADATA_MAX_STRING_CHARS = 4096;

/**
 * Shapes that are unambiguously credentials rather than names. Checked
 * case-insensitively and anywhere inside the value, because a pasted key is
 * often wrapped in a sentence or a keychain path.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
	/(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]/i,
	/github_pat_[A-Za-z0-9_]/i,
	/xox[bp]-[A-Za-z0-9-]/i,
	/AKIA[0-9A-Z]{16}/i,
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/i,
];

const SECRET_KEY_PATTERN =
	/^(?:api[_-]?key|secret|password|passwd|client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|credential|secret[_-]?value)$/i;

/** True when a value looks like provider key material, never a name. */
export function looksLikeCredentialSecret(value: string): boolean {
	if (value.length > MAX_SECRET_SCAN_CHARS) return true;
	return CREDENTIAL_SHAPES.some((pattern) => pattern.test(value));
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Opaque device-side credential name. Stricter than the shared schema: the
 * name pattern is closed and secret-shaped values are refused here, before the
 * repository (which only enforces length and control characters).
 */
export const connectCredentialRefSchema = z
	.string()
	.min(1)
	.max(MAX_CREDENTIAL_REF_CHARS)
	.regex(CREDENTIAL_REF_PATTERN, "invalid credential ref")
	.refine((value) => !hasControlCharacters(value), "invalid credential ref")
	.refine(
		(value) => !looksLikeCredentialSecret(value),
		"credential ref must name a device-side credential, not contain a secret",
	);

const connectBodySchema = z.strictObject({
	deviceId: z.uuid(),
	connectorId: z.enum(CONNECTOR_CONNECT_IDS),
	displayName: connectorDisplayNameSchema,
	authKind: connectorAuthKindSchema,
	credentialRef: connectCredentialRefSchema,
	scopes: connectorScopesSchema.optional(),
	freeTierProfile: freeTierProfileSchema.optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const revokeBodySchema = z.strictObject({
	credentialId: z.uuid(),
});

const listQuerySchema = z.strictObject({
	deviceId: z.uuid().optional(),
});

const scopeShapeSchema = z.strictObject({
	organizationId: z.uuid(),
	userId: z.uuid(),
	role: z.enum(["owner", "admin", "member", "viewer"]),
});

export type ConnectorConnectInput = z.input<typeof connectBodySchema>;
export type ConnectorListInput = z.input<typeof listQuerySchema>;
export type ConnectorRevokeInput = z.input<typeof revokeBodySchema>;

export type ConnectorConnectReceipt = { readonly credentialId: string };

export type ConnectorCredentialView = {
	readonly id: string;
	readonly deviceId: string;
	readonly connectorId: string;
	readonly displayName: string;
	readonly authKind: ConnectorCredentialSummary["authKind"];
	readonly credentialRef: string;
	readonly scopes: readonly string[];
	readonly status: ConnectorCredentialSummary["status"];
	readonly freeTierProfile: Readonly<FreeTierProfile>;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly lastValidatedAt: string | null;
	readonly lastUsedAt: string | null;
};

export type ConnectorRevokeReceipt = {
	readonly credentialId: string;
	readonly status: "revoked";
};

export const CONNECTOR_CONNECT_FAILURE_CODES = [
	"INVALID_INPUT",
	"AUTH_REQUIRED",
	"FORBIDDEN",
	"NOT_FOUND",
	"RATE_LIMITED",
	"UNAVAILABLE",
] as const;
export type ConnectorConnectFailureCode =
	(typeof CONNECTOR_CONNECT_FAILURE_CODES)[number];

/**
 * Fixed, bounded text. No entry interpolates request data, a database message,
 * a credential ref or an environment value.
 */
export const CONNECTOR_CONNECT_FAILURE_MESSAGES: Record<
	ConnectorConnectFailureCode,
	string
> = {
	INVALID_INPUT: "The connector request is invalid.",
	AUTH_REQUIRED: "Sign in to manage connector credentials.",
	FORBIDDEN:
		"This action requires an owner or admin role in this organization.",
	NOT_FOUND: "The connector record was not found.",
	RATE_LIMITED: "Too many connector requests. Try again shortly.",
	UNAVAILABLE:
		"Connector connect is not configured or is temporarily unavailable.",
};

export type ConnectorConnectResult<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly error: {
				readonly code: ConnectorConnectFailureCode;
				readonly message: string;
				/** Set only for RATE_LIMITED; drives the 429 `Retry-After`. */
				readonly retryAfterSeconds?: number;
			};
	  };

export type ConnectorConnectDependencies = {
	devices: ConnectorDeviceRepository;
	credentials: ConnectorCredentialRepository;
	/** Trusted server-side identity adapter; never a request field. */
	resolveScope: () => Promise<CallerScope>;
	/**
	 * Per-user throttle, applied after the scope and capability are known.
	 * Production wiring always supplies it; a missing gate is the test shape.
	 */
	rateLimiter?: UserRateLimitGate;
};

export type ConnectorConnectService = {
	connect(
		input: unknown,
	): Promise<ConnectorConnectResult<ConnectorConnectReceipt>>;
	list(
		input: unknown,
	): Promise<ConnectorConnectResult<ConnectorCredentialView[]>>;
	revoke(
		input: unknown,
	): Promise<ConnectorConnectResult<ConnectorRevokeReceipt>>;
};

/** Internal control-flow signal; maps to a fixed failure below. */
class ConnectorRefusal extends Error {
	constructor(readonly code: ConnectorConnectFailureCode) {
		super(code);
		this.name = "ConnectorRefusal";
	}
}

function failure<T>(
	code: ConnectorConnectFailureCode,
	retryAfterSeconds?: number,
): ConnectorConnectResult<T> {
	return {
		ok: false,
		error: {
			code,
			message: CONNECTOR_CONNECT_FAILURE_MESSAGES[code],
			...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		},
	};
}

function failureFromError<T>(error: unknown): ConnectorConnectResult<T> {
	if (error instanceof ConnectorRefusal) return failure(error.code);
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

function metadataIsSafe(
	value: unknown,
	depth: number,
	seen: WeakSet<object>,
): boolean {
	if (depth > METADATA_MAX_DEPTH) return false;
	if (typeof value === "string") {
		return (
			value.length <= METADATA_MAX_STRING_CHARS &&
			!looksLikeCredentialSecret(value)
		);
	}
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) {
		return (
			value.length <= METADATA_MAX_ARRAY_ITEMS &&
			value.every((entry) => metadataIsSafe(entry, depth + 1, seen))
		);
	}
	const entries = Object.entries(value);
	if (entries.length > METADATA_MAX_KEYS) return false;
	return entries.every(
		([key, entry]) =>
			!SECRET_KEY_PATTERN.test(key) && metadataIsSafe(entry, depth + 1, seen),
	);
}

/**
 * All free-text fields are checked, not just `credentialRef`: a pasted provider
 * key in a display name, a scope or metadata is refused the same way.
 */
function requestTextIsClean(input: {
	displayName: string;
	credentialRef: string;
	scopes: readonly string[];
	metadata: Record<string, unknown>;
}): boolean {
	if (looksLikeCredentialSecret(input.displayName)) return false;
	if (looksLikeCredentialSecret(input.credentialRef)) return false;
	if (input.scopes.some((scope) => looksLikeCredentialSecret(scope))) {
		return false;
	}
	return metadataIsSafe(input.metadata, 0, new WeakSet<object>());
}

function toView(summary: ConnectorCredentialSummary): ConnectorCredentialView {
	return {
		id: summary.id,
		deviceId: summary.deviceId,
		connectorId: summary.connectorId,
		displayName: summary.displayName,
		authKind: summary.authKind,
		credentialRef: summary.credentialRef,
		scopes: [...summary.scopes],
		status: summary.status,
		freeTierProfile: { ...summary.freeTierProfile },
		metadata: { ...summary.metadata },
		lastValidatedAt:
			summary.lastValidatedAt === null
				? null
				: new Date(summary.lastValidatedAt).toISOString(),
		lastUsedAt:
			summary.lastUsedAt === null
				? null
				: new Date(summary.lastUsedAt).toISOString(),
	};
}

export function createConnectorConnectService(
	dependencies: ConnectorConnectDependencies,
): ConnectorConnectService {
	const scoped = async <T>(
		capability: PlatformCapability | null,
		action: UserRateLimitAction,
		handler: (scope: CallerScope) => Promise<T>,
	): Promise<ConnectorConnectResult<T>> => {
		try {
			const scope = await dependencies.resolveScope();
			if (!scopeShapeSchema.safeParse(scope).success) {
				return failure("AUTH_REQUIRED");
			}
			// The role from the membership row is the only authorization input.
			if (capability !== null && !hasCapability(scope.role, capability)) {
				return failure("FORBIDDEN");
			}
			// Throttle only a caller who passed identity and capability checks.
			if (dependencies.rateLimiter !== undefined) {
				await dependencies.rateLimiter.enforce(scope.userId, action);
			}
			return { ok: true, value: await handler(scope) };
		} catch (error) {
			return failureFromError(error);
		}
	};

	return {
		async connect(input) {
			const parsed = connectBodySchema.safeParse(input);
			if (!parsed.success) return failure("INVALID_INPUT");
			const body = parsed.data;
			return scoped("member:manage", "connector:connect", async (scope) => {
				const metadata = body.metadata ?? {};
				if (
					!requestTextIsClean({
						displayName: body.displayName,
						credentialRef: body.credentialRef,
						scopes: body.scopes ?? [],
						metadata,
					})
				) {
					throw new ConnectorRefusal("INVALID_INPUT");
				}
				// Tenant-scoped read: a foreign device simply does not appear.
				const devices = await dependencies.devices.listByOrganization(
					scope.organizationId,
				);
				const device = devices.find(
					(candidate) => candidate.id === body.deviceId,
				);
				// A pending/revoked device is as invisible as another tenant's.
				if (device === undefined || device.status !== "active") {
					throw new ConnectorRefusal("NOT_FOUND");
				}
				const created = await dependencies.credentials.create({
					organizationId: scope.organizationId,
					deviceId: body.deviceId,
					connectorId: body.connectorId,
					displayName: body.displayName,
					authKind: body.authKind,
					credentialRef: body.credentialRef,
					scopes: body.scopes ?? [],
					status: "pending_validation",
					freeTierProfile: body.freeTierProfile ?? emptyFreeTierProfile(),
					metadata,
					createdBy: scope.userId,
				});
				// The receipt names the row; the server has no secret to return.
				return { credentialId: created.id };
			});
		},

		async list(input) {
			const parsed = listQuerySchema.safeParse(input ?? {});
			if (!parsed.success) return failure("INVALID_INPUT");
			return scoped(null, "connector:list", async (scope) => {
				const rows = await dependencies.credentials.listByOrganization(
					scope.organizationId,
				);
				const filtered =
					parsed.data.deviceId === undefined
						? rows
						: rows.filter((row) => row.deviceId === parsed.data.deviceId);
				return filtered.map(toView);
			});
		},

		async revoke(input) {
			const parsed = revokeBodySchema.safeParse(input);
			if (!parsed.success) return failure("INVALID_INPUT");
			return scoped("member:manage", "connector:revoke", async (scope) => {
				// The update carries organization_id, so a foreign id is a 404 and
				// never flips another tenant's row. Repeating the call is harmless.
				const revoked = await dependencies.credentials.revoke(
					scope.organizationId,
					parsed.data.credentialId,
				);
				if (revoked === null) throw new ConnectorRefusal("NOT_FOUND");
				return { credentialId: revoked.id, status: "revoked" as const };
			});
		},
	};
}

/*
 * Runtime wiring. Configuration is read from the environment, but identity is
 * never: the caller scope comes from the session resolver and the membership
 * row, exactly as it does for task actions.
 */

export class ConnectorConnectNotConfiguredError extends Error {
	constructor() {
		super("connector connect is not configured");
		this.name = "ConnectorConnectNotConfiguredError";
	}
}

export type ConnectorRouteOptions = {
	env?: Record<string, string | undefined>;
	service?: ConnectorConnectService;
};

let sql: PgSql | undefined;
let sqlUrl: string | undefined;
let service: ConnectorConnectService | undefined;
let serviceKey: string | undefined;

function getDatabase(databaseUrl: string): PgSql {
	if (sql === undefined || sqlUrl !== databaseUrl) {
		sql = createDb(databaseUrl);
		sqlUrl = databaseUrl;
	}
	return sql;
}

export function getConnectorConnectService(
	env: Record<string, string | undefined> = process.env,
): ConnectorConnectService {
	if (!isDeviceGatewayEnabled(env)) {
		throw new ConnectorConnectNotConfiguredError();
	}
	const databaseUrl = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
		throw new ConnectorConnectNotConfiguredError();
	}
	// Fail closed before opening a connection when auth is unusable.
	const settings = readNeonAuthSettings(env);
	if (settings === null) throw new ConnectorConnectNotConfiguredError();
	const key = `${databaseUrl}\u0000${settings.baseUrl}`;
	if (service !== undefined && serviceKey === key) return service;

	const database = getDatabase(databaseUrl);
	const runtime = createAuthRuntime(database, settings);
	service = createConnectorConnectService({
		devices: new PostgresConnectorDeviceRepository(database),
		credentials: new PostgresConnectorCredentialRepository(database),
		resolveScope: () =>
			resolveCallerScope({
				session: runtime.session,
				memberships: runtime.memberships,
				preferredOrganizationId: readActiveOrganizationPreference(),
			}),
		rateLimiter: createUserRateLimitGate(
			new PostgresRateLimitRepository(database),
		),
	});
	serviceKey = key;
	return service;
}

/** Test-only seam: reset the process-local database/service bundle. */
export function resetConnectorConnectForTests(): void {
	sql = undefined;
	sqlUrl = undefined;
	service = undefined;
	serviceKey = undefined;
}

/*
 * Route adapters. Every configuration, database or parse failure collapses to a
 * fixed response; the route modules stay one-liners.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

const FAILURE_STATUS: Record<ConnectorConnectFailureCode, number> = {
	INVALID_INPUT: 400,
	AUTH_REQUIRED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	RATE_LIMITED: 429,
	UNAVAILABLE: 503,
};

class ConnectorBodyTooLargeError extends Error {
	constructor() {
		super("connector request body is too large");
		this.name = "ConnectorBodyTooLargeError";
	}
}

function json(status: number, body: unknown): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

function unavailable(): Response {
	return json(503, {
		error: CONNECTOR_CONNECT_FAILURE_MESSAGES.UNAVAILABLE,
	});
}

function invalidInput(): Response {
	return json(400, { error: CONNECTOR_CONNECT_FAILURE_MESSAGES.INVALID_INPUT });
}

function respond<T>(result: ConnectorConnectResult<T>): Response {
	if (result.ok) return json(200, result.value);
	// One fixed 429 shape (with Retry-After) across every route in the app.
	if (result.error.code === "RATE_LIMITED") {
		return rateLimitedResponse(result.error.retryAfterSeconds ?? 0);
	}
	return json(FAILURE_STATUS[result.error.code], {
		error: result.error.message,
	});
}

function serviceFor(options: ConnectorRouteOptions): ConnectorConnectService {
	if (options.service !== undefined) return options.service;
	return getConnectorConnectService(options.env ?? process.env);
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
			throw new ConnectorBodyTooLargeError();
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
			if (total > maxBytes) throw new ConnectorBodyTooLargeError();
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
		if (error instanceof ConnectorBodyTooLargeError) throw error;
		throw new ConnectorRefusal("INVALID_INPUT");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ConnectorRefusal("INVALID_INPUT");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConnectorRefusal("INVALID_INPUT");
	}
	return parsed;
}

export async function handleConnectorConnectRoute(
	request: Request,
	options: ConnectorRouteOptions = {},
): Promise<Response> {
	let connectorService: ConnectorConnectService;
	try {
		connectorService = serviceFor(options);
	} catch {
		return unavailable();
	}
	let body: unknown;
	try {
		body = await readJsonBody(request, CONNECTOR_CONNECT_MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof ConnectorBodyTooLargeError) {
			return json(413, { error: "The connector request body is too large." });
		}
		return invalidInput();
	}
	try {
		return respond(await connectorService.connect(body));
	} catch {
		return unavailable();
	}
}

export async function handleConnectorListRoute(
	request: Request,
	options: ConnectorRouteOptions = {},
): Promise<Response> {
	let connectorService: ConnectorConnectService;
	try {
		connectorService = serviceFor(options);
	} catch {
		return unavailable();
	}
	const query: { deviceId?: string } = {};
	try {
		const url = new URL(request.url);
		// Only an exact, single `deviceId` is accepted; anything else is ignored.
		const deviceId = url.searchParams.get("deviceId");
		if (deviceId !== null) query.deviceId = deviceId;
	} catch {
		return invalidInput();
	}
	try {
		const result = await connectorService.list(query);
		// A stable object shape: never a bare array at the HTTP boundary.
		return result.ok
			? json(200, { credentials: result.value })
			: respond(result);
	} catch {
		return unavailable();
	}
}

export async function handleConnectorRevokeRoute(
	request: Request,
	options: ConnectorRouteOptions = {},
): Promise<Response> {
	let connectorService: ConnectorConnectService;
	try {
		connectorService = serviceFor(options);
	} catch {
		return unavailable();
	}
	let body: unknown;
	try {
		body = await readJsonBody(request, CONNECTOR_CONNECT_MAX_BODY_BYTES);
	} catch (error) {
		if (error instanceof ConnectorBodyTooLargeError) {
			return json(413, { error: "The connector request body is too large." });
		}
		return invalidInput();
	}
	try {
		return respond(await connectorService.revoke(body));
	} catch {
		return unavailable();
	}
}

/** Environment variable name re-exported for ops visibility in tests/docs. */
export const CONNECTOR_CONNECT_GATE_VARIABLE = DEVICE_GATEWAY_ENABLED_VARIABLE;

/** Narrowing helper kept next to the route for clarity in logs. */
export function isConnectorConnectEnabled(
	env: Record<string, string | undefined>,
): boolean {
	return isDeviceGatewayEnabled(env) && (env.DATABASE_URL ?? "").trim() !== "";
}
