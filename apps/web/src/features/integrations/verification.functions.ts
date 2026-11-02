import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { verifyConnectorCredential as verifyConnectorCredentialOnServer } from "@/server/connector-verification.server";
import {
	type ConnectorVerificationResult,
	verificationFailure,
	verifyCredentialInputSchema,
} from "./verification";

/**
 * Explicit connector verification action.
 *
 * The browser sends one credential id. The server enqueues exactly one
 * `connector.verify` device call and returns a bounded status, a closed reason
 * code and an optional verification time. A provider body, URL or secret can
 * never cross this seam; thrown errors collapse to one fixed unavailable code.
 */
export const verifyConnectorCredentialRequest = createServerFn({
	method: "POST",
})
	.validator((input: unknown) => {
		const parsed = verifyCredentialInputSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid verification request.");
		return parsed.data;
	})
	.handler(async ({ data }): Promise<ConnectorVerificationResult> => {
		setResponseHeader("Cache-Control", "private, no-store");
		try {
			const result = await verifyConnectorCredentialOnServer(data);
			if (!result.ok) {
				return verificationFailure(
					result.error.code,
					result.error.retryAfterSeconds,
				);
			}
			return {
				ok: true,
				value: {
					credentialId: result.value.credentialId,
					status: result.value.status,
					reasonCode: result.value.reasonCode,
					verifiedAt: result.value.verifiedAt,
				},
			};
		} catch {
			return verificationFailure("UNAVAILABLE");
		}
	});

/** Client entry point used by the verification panel. */
export async function verifyConnectorCredentialAction(
	credentialId: string,
): Promise<ConnectorVerificationResult> {
	const parsed = verifyCredentialInputSchema.safeParse({ credentialId });
	if (!parsed.success) return verificationFailure("INVALID_INPUT");
	return verifyConnectorCredentialRequest({ data: parsed.data });
}
