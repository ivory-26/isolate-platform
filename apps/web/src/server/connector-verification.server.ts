import "@tanstack/react-start/server-only";

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

/** True only when the device gateway and database are configured. */
export function isConnectorVerificationEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const gateway = env.DEVICE_GATEWAY_ENABLED?.trim().toLowerCase();
	return gateway === "true" && (env.DATABASE_URL ?? "").trim().length > 0;
}

/**
 * Placeholder implementation replaced by the web-server lane. It is a fixed,
 * honest failure rather than a fake success, so the UI cannot claim a verified
 * connection before the route exists.
 */
export async function verifyConnectorCredential(
	_input: VerifyConnectorCredentialInput,
): Promise<ConnectorVerificationResult> {
	return {
		ok: false,
		error: {
			code: "UNAVAILABLE",
			message: CONNECTOR_VERIFICATION_FAILURE_MESSAGES.UNAVAILABLE,
		},
	};
}
