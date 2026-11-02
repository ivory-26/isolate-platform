import "@tanstack/react-start/server-only";
import {
	type ConnectorCallRepository,
	type ConnectorCredentialRepository,
	createDb,
	hasCapability,
	type PgSql,
	PostgresConnectorCallRepository,
	PostgresConnectorCredentialRepository,
	PostgresRateLimitRepository,
} from "@isolate/db";
import {
	CONNECTOR_VERIFY_TOOL_NAME,
	type ConnectorCredentialStatus,
	type ConnectorVerifyReasonCode,
	connectorVerifyDeviceResultSchema,
	type OrganizationId,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { readActiveOrganizationPreference } from "./active-organization.server";
import { createAuthRuntime } from "./auth-runtime.server";
import { resolveCallerScope } from "./caller-scope.server";
import { isDeviceGatewayEnabled } from "./device-gateway.server";
import { readNeonAuthSettings } from "./neon-auth.server";
import {
	createUserRateLimitGate,
	RateLimitExceededError,
	type UserRateLimitAction,
	type UserRateLimitGate,
} from "./rate-limit.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

/**
 * Connector credential verification (wave 24).
 *
 * The server enqueues exactly one `connector.verify` device call and waits a
 * bounded time for the relay to perform one cheap authenticated provider read.
 * A successful read promotes a `pending_validation` credential to `active`; a
 * rejected credential becomes `invalid`; a relay timeout leaves the current
 * status untouched. No provider body, URL or credential crosses this boundary.
 *
 * CONTRACT: this file is the frozen seam between the server lane and the UI
 * lane. The UI imports only the exported types and `verifyConnectorCredential`.
 */

export const CONNECTOR_VERIFICATION_FAILURE_CODES = [
	"INVALID_INPUT",
	"AUTH_REQUIRED",
	"FORBIDDEN",
	"NOT_FOUND",
	"RATE_LIMITED",
	"UNAVAILABLE",
] as const;
export type ConnectorVerificationFailureCode =
	(typeof CONNECTOR_VERIFICATION_FAILURE_CODES)[number];

export const CONNECTOR_VERIFICATION_FAILURE_MESSAGES: Record<
	ConnectorVerificationFailureCode,
	string
> = {
	INVALID_INPUT: "The verification request is invalid.",
	AUTH_REQUIRED: "Sign in to verify connector credentials.",
	FORBIDDEN:
		"This action requires an owner or admin role in this organization.",
	NOT_FOUND: "The connector credential was not found.",
	RATE_LIMITED: "Too many verification requests. Try again shortly.",
	UNAVAILABLE:
		"Connector verification is not configured or is temporarily unavailable.",
};

/** Status the credential holds after the attempt. */
export type ConnectorVerificationStatus =
	| "active"
	| "invalid"
	| "pending_validation";

export type ConnectorVerificationView = {
	readonly credentialId: string;
	readonly status: ConnectorVerificationStatus;
	/** Closed reason code from `@isolate/shared`; never provider text. */
	readonly reasonCode: string;
	/** Set only when the verification read succeeded. */
	readonly verifiedAt: string | null;
};

export type ConnectorVerificationResult =
	| { readonly ok: true; readonly value: ConnectorVerificationView }
	| {
			readonly ok: false;
			readonly error: {
				readonly code: ConnectorVerificationFailureCode;
				readonly message: string;
				readonly retryAfterSeconds?: number;
			};
	  };

export type VerifyConnectorCredentialInput = {
	readonly credentialId: string;
};

/**
 * One verification is a single bounded read, not an agent tool call: a short
 * queue TTL, a 20 s wait and a 250 ms poll keep the whole request under half a
 * minute even when the relay is offline.
 */
export const CONNECTOR_VERIFY_CALL_TTL_MS = 30_000;
export const CONNECTOR_VERIFY_AWAIT_TIMEOUT_MS = 20_000;
export const CONNECTOR_VERIFY_AWAIT_POLL_MS = 250;
export const CONNECTOR_VERIFY_RATE_LIMITED_RETRY_AFTER_SECONDS = 30;

/**
 * Verification reuses the connector-management bucket (`connector:connect`,
 * 30/min). A dedicated action would widen the shared rate-limit policy for no
 * extra safety: this is the same owner/admin connector budget.
 */
const VERIFY_RATE_LIMIT_ACTION: UserRateLimitAction = "connector:connect";

const credentialIdSchema = z.uuid();
const verifyInputSchema = z.strictObject({
	credentialId: credentialIdSchema,
});
const scopeShapeSchema = z.strictObject({
	organizationId: z.uuid(),
	userId: z.uuid(),
	role: z.enum(["owner", "admin", "member", "viewer"]),
});

/** True only when the device gateway and database are configured. */
export function isConnectorVerificationEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const gateway = env.DEVICE_GATEWAY_ENABLED?.trim().toLowerCase();
	return gateway === "true" && (env.DATABASE_URL ?? "").trim().length > 0;
}

/**
 * Narrow repository seams keep the service testable without a database and
 * make the writes this flow is allowed to perform explicit.
 */
export type ConnectorVerificationDependencies = {
	credentials: Pick<
		ConnectorCredentialRepository,
		"get" | "setStatus" | "touchValidated"
	>;
	calls: Pick<ConnectorCallRepository, "enqueue" | "awaitResult">;
	/** Trusted server-side identity; never a request field. */
	resolveScope: () => Promise<CallerScope>;
	/** Applied after identity and capability are known, before any enqueue. */
	rateLimiter?: UserRateLimitGate;
	now?: () => Date;
	/** Test seam only; production always uses the bounded constants above. */
	awaitTimeoutMs?: number;
	pollMs?: number;
};

export type ConnectorVerificationService = {
	verify(input: unknown): Promise<ConnectorVerificationResult>;
};

function failure(
	code: ConnectorVerificationFailureCode,
	retryAfterSeconds?: number,
): ConnectorVerificationResult {
	return {
		ok: false,
		error: {
			code,
			message: CONNECTOR_VERIFICATION_FAILURE_MESSAGES[code],
			...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
		},
	};
}

function failureFromError(error: unknown): ConnectorVerificationResult {
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

function view(
	credentialId: string,
	status: ConnectorVerificationStatus,
	reasonCode: ConnectorVerifyReasonCode,
	verifiedAt: string | null,
): ConnectorVerificationResult {
	return {
		ok: true,
		value: { credentialId, status, reasonCode, verifiedAt },
	};
}

/**
 * Only the three verifiable states can be returned. `revoked` (and anything a
 * future migration adds) is treated exactly like a missing row.
 */
function toVerificationStatus(
	status: ConnectorCredentialStatus,
): ConnectorVerificationStatus | null {
	if (status === "active" || status === "invalid") return status;
	if (status === "pending_validation") return status;
	return null;
}

export function createConnectorVerificationService(
	dependencies: ConnectorVerificationDependencies,
): ConnectorVerificationService {
	const now = dependencies.now ?? (() => new Date());
	const awaitTimeoutMs =
		dependencies.awaitTimeoutMs ?? CONNECTOR_VERIFY_AWAIT_TIMEOUT_MS;
	const pollMs = dependencies.pollMs ?? CONNECTOR_VERIFY_AWAIT_POLL_MS;

	/**
	 * Revocation wins: a credential revoked while the relay was answering is
	 * never promoted (or re-marked) after the fact.
	 */
	const stillWritable = async (
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<boolean> => {
		const latest = await dependencies.credentials.get(
			organizationId,
			credentialId,
		);
		return latest !== null && latest.status !== "revoked";
	};

	const markInvalid = async (
		organizationId: OrganizationId,
		credentialId: string,
		reasonCode: ConnectorVerifyReasonCode,
	): Promise<ConnectorVerificationResult> => {
		if (!(await stillWritable(organizationId, credentialId))) {
			return failure("NOT_FOUND");
		}
		const updated = await dependencies.credentials.setStatus(
			organizationId,
			credentialId,
			"invalid",
		);
		if (updated === null) return failure("NOT_FOUND");
		// A rejected read proves the credential is wrong, not that it was valid:
		// `last_validated_at` is deliberately left untouched and the view says
		// nothing was verified.
		return view(credentialId, "invalid", reasonCode, null);
	};

	return {
		async verify(input) {
			const parsed = verifyInputSchema.safeParse(input);
			if (!parsed.success) return failure("INVALID_INPUT");
			try {
				const scope = await dependencies.resolveScope();
				if (!scopeShapeSchema.safeParse(scope).success) {
					return failure("AUTH_REQUIRED");
				}
				// The role from the membership row is the only authorization input.
				if (!hasCapability(scope.role, "member:manage")) {
					return failure("FORBIDDEN");
				}
				if (dependencies.rateLimiter !== undefined) {
					await dependencies.rateLimiter.enforce(
						scope.userId,
						VERIFY_RATE_LIMIT_ACTION,
					);
				}
				const credential = await dependencies.credentials.get(
					scope.organizationId,
					parsed.data.credentialId,
				);
				// A foreign id is indistinguishable from a missing one; a revoked
				// credential is never verified or handed to a relay.
				if (
					credential === null ||
					credential.organizationId !== scope.organizationId ||
					credential.status === "revoked"
				) {
					return failure("NOT_FOUND");
				}
				const currentStatus = toVerificationStatus(credential.status);
				if (currentStatus === null) return failure("NOT_FOUND");
				const previousValidatedAt =
					credential.lastValidatedAt === null
						? null
						: new Date(credential.lastValidatedAt).toISOString();

				const call = await dependencies.calls.enqueue({
					organizationId: scope.organizationId,
					deviceId: credential.deviceId,
					credentialId: credential.id,
					connectorId: credential.connectorId,
					toolName: CONNECTOR_VERIFY_TOOL_NAME,
					params: {},
					ttlMs: CONNECTOR_VERIFY_CALL_TTL_MS,
				});

				// The scoped read can only ever see this tenant's call for this
				// device, so a leaked id cannot read another organization's result.
				const outcome = await dependencies.calls.awaitResult(
					call.id,
					awaitTimeoutMs,
					pollMs,
					{
						organizationId: scope.organizationId,
						deviceId: credential.deviceId,
					},
				);

				if (outcome === null) {
					// Bounded "relay did not answer": do not claim a status change.
					return view(
						credential.id,
						currentStatus,
						"UNREACHABLE",
						previousValidatedAt,
					);
				}

				if (!outcome.ok) {
					if (outcome.errorCode === "RATE_LIMITED") {
						return failure(
							"RATE_LIMITED",
							CONNECTOR_VERIFY_RATE_LIMITED_RETRY_AFTER_SECONDS,
						);
					}
					if (outcome.errorCode === "EXPIRED") {
						return view(
							credential.id,
							currentStatus,
							"UNREACHABLE",
							previousValidatedAt,
						);
					}
					if (outcome.errorCode === "INTERNAL") {
						return view(
							credential.id,
							currentStatus,
							"PROVIDER_ERROR",
							previousValidatedAt,
						);
					}
					if (
						outcome.errorCode === "NOT_FOUND" ||
						outcome.errorCode === "INTEGRATION_UNAVAILABLE" ||
						outcome.errorCode === "VALIDATION_FAILED"
					) {
						// The relay could not use the stored credential as configured.
						return markInvalid(
							scope.organizationId,
							credential.id,
							"CONFIG_REQUIRED",
						);
					}
					// POLICY_DENIED and any future code: bounded, no status claim.
					return view(
						credential.id,
						currentStatus,
						"PROVIDER_ERROR",
						previousValidatedAt,
					);
				}

				const deviceResult = connectorVerifyDeviceResultSchema.safeParse(
					outcome.data,
				);
				if (!deviceResult.success) {
					// A malformed success payload is a relay bug, not proof that the
					// credential is wrong or right: leave the stored status alone.
					return view(
						credential.id,
						currentStatus,
						"PROVIDER_ERROR",
						previousValidatedAt,
					);
				}

				if (deviceResult.data.verified) {
					if (deviceResult.data.reasonCode !== "OK") {
						return view(
							credential.id,
							currentStatus,
							"PROVIDER_ERROR",
							previousValidatedAt,
						);
					}
					const validatedAt = now();
					if (!(await stillWritable(scope.organizationId, credential.id))) {
						return failure("NOT_FOUND");
					}
					const active = await dependencies.credentials.setStatus(
						scope.organizationId,
						credential.id,
						"active",
					);
					if (active === null) return failure("NOT_FOUND");
					const touched = await dependencies.credentials.touchValidated(
						scope.organizationId,
						credential.id,
						validatedAt,
					);
					if (touched === null) return failure("NOT_FOUND");
					const verifiedAt = (
						touched.lastValidatedAt ?? validatedAt
					).toISOString();
					return view(credential.id, "active", "OK", verifiedAt);
				}

				// `verified: false` is a real answer. `OK` alongside it is
				// contradictory, so it is reported as a provider fault instead.
				const reasonCode: ConnectorVerifyReasonCode =
					deviceResult.data.reasonCode === "OK"
						? "PROVIDER_ERROR"
						: deviceResult.data.reasonCode;
				return markInvalid(scope.organizationId, credential.id, reasonCode);
			} catch (error) {
				return failureFromError(error);
			}
		},
	};
}

/*
 * Runtime wiring. Configuration comes from the environment; identity never
 * does: the caller scope comes from the session resolver and the membership
 * row, exactly as it does for the connector connect surface.
 */

export class ConnectorVerificationNotConfiguredError extends Error {
	constructor() {
		super("connector verification is not configured");
		this.name = "ConnectorVerificationNotConfiguredError";
	}
}

let sql: PgSql | undefined;
let sqlUrl: string | undefined;
let service: ConnectorVerificationService | undefined;
let serviceKey: string | undefined;

function getDatabase(databaseUrl: string): PgSql {
	if (sql === undefined || sqlUrl !== databaseUrl) {
		sql = createDb(databaseUrl);
		sqlUrl = databaseUrl;
	}
	return sql;
}

/**
 * Builds the service from the environment. Disabled by default and missing
 * `DATABASE_URL` or Neon Auth settings all fail closed with a fixed
 * `UNAVAILABLE` at the exported boundary.
 */
export function getConnectorVerificationService(
	env: Record<string, string | undefined> = process.env,
): ConnectorVerificationService {
	if (!isDeviceGatewayEnabled(env)) {
		throw new ConnectorVerificationNotConfiguredError();
	}
	const databaseUrl = env.DATABASE_URL?.trim();
	if (databaseUrl === undefined || databaseUrl.length === 0) {
		throw new ConnectorVerificationNotConfiguredError();
	}
	// Fail closed before opening a connection when auth is unusable.
	const settings = readNeonAuthSettings(env);
	if (settings === null) throw new ConnectorVerificationNotConfiguredError();
	const key = `${databaseUrl}\u0000${settings.baseUrl}`;
	if (service !== undefined && serviceKey === key) return service;

	const database = getDatabase(databaseUrl);
	const runtime = createAuthRuntime(database, settings);
	service = createConnectorVerificationService({
		credentials: new PostgresConnectorCredentialRepository(database),
		calls: new PostgresConnectorCallRepository(database),
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
export function resetConnectorVerificationForTests(): void {
	sql = undefined;
	sqlUrl = undefined;
	service = undefined;
	serviceKey = undefined;
}

export async function verifyConnectorCredential(
	input: VerifyConnectorCredentialInput,
): Promise<ConnectorVerificationResult> {
	let verificationService: ConnectorVerificationService;
	try {
		verificationService = getConnectorVerificationService(process.env);
	} catch {
		return failure("UNAVAILABLE");
	}
	try {
		return await verificationService.verify(input);
	} catch {
		// The service already maps every known failure; this is the final guard
		// against a driver, process or future code path escaping as a 500.
		return failure("UNAVAILABLE");
	}
}
