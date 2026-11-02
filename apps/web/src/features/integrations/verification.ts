import {
	CONNECTOR_VERIFY_REASON_CODES,
	type ConnectorVerifyReasonCode,
} from "@isolate/shared";
import { z } from "zod";
import type {
	ConnectorVerificationFailureCode,
	ConnectorVerificationResult,
} from "@/server/connector-verification.server";
import type { ConnectorCredentialStatus } from "../devices/contracts";

export type { ConnectorVerificationResult };

/**
 * Client-safe verification contract.
 *
 * The server seam lives in `@/server/connector-verification.server`; only its
 * types are imported here so tests and presentational components never load a
 * server-only module. Every message is fixed: no provider text, URL, request
 * value or credential can reach the browser through a verification result.
 */

export const verifyCredentialInputSchema = z.strictObject({
	credentialId: z.uuid(),
});
export type VerifyCredentialInput = z.infer<typeof verifyCredentialInputSchema>;

export const VERIFICATION_FAILURE_MESSAGES = {
	INVALID_INPUT: "The verification request is invalid.",
	AUTH_REQUIRED: "Sign in to verify connector credentials.",
	FORBIDDEN:
		"This action requires an owner or admin role in this organization.",
	NOT_FOUND: "The connector credential was not found.",
	RATE_LIMITED: "Too many verification requests. Try again shortly.",
	UNAVAILABLE:
		"Connector verification is not configured or is temporarily unavailable.",
} as const satisfies Record<ConnectorVerificationFailureCode, string>;

export function verificationFailureMessage(code: string): string {
	return (
		VERIFICATION_FAILURE_MESSAGES[code as ConnectorVerificationFailureCode] ??
		VERIFICATION_FAILURE_MESSAGES.UNAVAILABLE
	);
}

/**
 * Map a failure to the frozen result union with a fixed message. An optional
 * retry delay is clamped so a server value cannot produce an unbounded label.
 */
export function verificationFailure(
	code: ConnectorVerificationFailureCode,
	retryAfterSeconds?: number,
): ConnectorVerificationResult {
	const retry =
		typeof retryAfterSeconds === "number" &&
		Number.isFinite(retryAfterSeconds) &&
		retryAfterSeconds > 0
			? Math.min(Math.floor(retryAfterSeconds), 3_600)
			: undefined;
	return {
		ok: false,
		error: {
			code,
			message: VERIFICATION_FAILURE_MESSAGES[code],
			...(retry === undefined ? {} : { retryAfterSeconds: retry }),
		},
	};
}

export const VERIFY_REASON_LABELS = {
	OK: "OK",
	AUTH_FAILED: "Authentication failed",
	CONFIG_REQUIRED: "Configuration required",
	UNREACHABLE: "Relay did not answer",
	RATE_LIMITED: "Rate limited",
	PROVIDER_ERROR: "Provider error",
} as const satisfies Record<ConnectorVerifyReasonCode, string>;

export function isVerificationReasonCode(
	value: string,
): value is ConnectorVerifyReasonCode {
	return (CONNECTOR_VERIFY_REASON_CODES as readonly string[]).includes(value);
}

/** Human label for a closed reason code; unknown values never echo raw text. */
export function verificationReasonLabel(value: string): string {
	return isVerificationReasonCode(value)
		? VERIFY_REASON_LABELS[value]
		: "Unknown result";
}

export function verificationRejectionMessage(reasonCode: string): string {
	const code = isVerificationReasonCode(reasonCode) ? ` (${reasonCode})` : "";
	return `Verification failed: ${verificationReasonLabel(reasonCode)}${code}.`;
}

/**
 * A relay timeout leaves the stored status untouched. It must never be shown
 * as a rejection or as a successful verification.
 */
export function verificationIncompleteMessage(reasonCode: string): string {
	if (reasonCode === "UNREACHABLE") {
		return "The relay did not answer within the verification window. The status is unchanged and this connection is not verified.";
	}
	return `Verification did not complete (${verificationReasonLabel(reasonCode)}). The status is unchanged and this connection is not verified.`;
}

/** Only these three states offer a verify action; a revoked row does not. */
export function isVerifiableStatus(status: string): boolean {
	return (
		status === "pending_validation" ||
		status === "invalid" ||
		status === "active"
	);
}

/**
 * Connection wording shared by the detail page and the connected table.
 * "Connected" is reserved for an active, previously verified credential.
 */
export const CONNECTION_STATUS_COPY: Record<
	ConnectorCredentialStatus,
	{ readonly label: string; readonly description: string }
> = {
	active: {
		label: "Connected",
		description: "The last bounded verification read succeeded.",
	},
	pending_validation: {
		label: "Verification pending",
		description:
			"The credential is stored on the relay but no bounded read has succeeded. This connection is not production-ready.",
	},
	invalid: {
		label: "Verification failed",
		description:
			"The relay rejected the credential. Reconnect with valid credentials, then verify again.",
	},
	revoked: {
		label: "Revoked",
		description: "This connection was disconnected and cannot be verified.",
	},
};

export function verificationStatusCopy(status: string): {
	readonly label: string;
	readonly description: string;
} {
	return (
		CONNECTION_STATUS_COPY[status as ConnectorCredentialStatus] ?? {
			label: "Status unknown",
			description:
				"The server returned a status this client does not recognise.",
		}
	);
}

export function verificationStatusLabel(status: string): string {
	return verificationStatusCopy(status).label;
}

/**
 * Pick the credential that just finished pairing, once per credential id.
 * Returns null until the relay reports completion with a credential id.
 */
export function autoVerificationCredentialId(
	session:
		| { readonly status: string; readonly credentialId?: string }
		| undefined,
	alreadyVerified: string | null,
): string | null {
	if (session?.status !== "completed") return null;
	const credentialId = session.credentialId;
	if (credentialId === undefined || credentialId === alreadyVerified) {
		return null;
	}
	return credentialId;
}
