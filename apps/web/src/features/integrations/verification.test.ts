import { describe, expect, test } from "bun:test";
import { CONNECTOR_VERIFY_REASON_CODES } from "@isolate/shared";
import { PAIRING_STATUS_LABELS } from "./contracts";
import {
	autoVerificationCredentialId,
	isVerifiableStatus,
	isVerificationReasonCode,
	VERIFICATION_FAILURE_MESSAGES,
	VERIFY_REASON_LABELS,
	verificationFailure,
	verificationFailureMessage,
	verificationIncompleteMessage,
	verificationReasonLabel,
	verificationRejectionMessage,
	verificationStatusCopy,
	verificationStatusLabel,
	verifyCredentialInputSchema,
} from "./verification";

const CREDENTIAL_ID = "33333333-3333-4333-8333-333333333333";

describe("verifyCredentialInputSchema", () => {
	test("accepts exactly one credential UUID", () => {
		expect(
			verifyCredentialInputSchema.safeParse({ credentialId: CREDENTIAL_ID })
				.success,
		).toBe(true);
	});

	test("rejects a non-UUID, a missing id and extra fields", () => {
		for (const input of [
			{ credentialId: "not-a-uuid" },
			{ credentialId: CREDENTIAL_ID, connectorId: "sentry" },
			{},
			null,
		]) {
			expect(verifyCredentialInputSchema.safeParse(input).success).toBe(false);
		}
	});
});

describe("verification reason labels", () => {
	test("labels every closed reason code", () => {
		for (const code of CONNECTOR_VERIFY_REASON_CODES) {
			expect(isVerificationReasonCode(code)).toBe(true);
			expect(verificationReasonLabel(code)).toBe(VERIFY_REASON_LABELS[code]);
			expect(verificationReasonLabel(code).length).toBeGreaterThan(0);
		}
	});

	test("never echoes an unknown reason code", () => {
		const label = verificationReasonLabel("SOMETHING_ELSE");
		expect(label).toBe("Unknown result");
		expect(label).not.toContain("SOMETHING_ELSE");
		expect(isVerificationReasonCode("SOMETHING_ELSE")).toBe(false);
	});

	test("shows the fixed code beside a rejected credential", () => {
		const message = verificationRejectionMessage("AUTH_FAILED");
		expect(message).toContain("Authentication failed");
		expect(message).toContain("AUTH_FAILED");
		expect(verificationRejectionMessage("UNKNOWN").includes("UNKNOWN")).toBe(
			false,
		);
	});

	test("a relay timeout is a bounded warning, not a success", () => {
		const timeout = verificationIncompleteMessage("UNREACHABLE");
		expect(timeout).toContain("did not answer");
		expect(timeout).toContain("not verified");
		expect(timeout).not.toContain("succeeded");

		const other = verificationIncompleteMessage("PROVIDER_ERROR");
		expect(other).toContain("did not complete");
		expect(other).toContain("Provider error");
		expect(other).toContain("not verified");
	});
});

describe("verification failure mapping", () => {
	test("uses one fixed message per failure code and never leaks a URL", () => {
		for (const [code, message] of Object.entries(
			VERIFICATION_FAILURE_MESSAGES,
		)) {
			expect(verificationFailureMessage(code)).toBe(message);
			expect(message).not.toMatch(/https?:\/\//);
			expect(message).not.toContain("token");
			expect(message).not.toContain("secret");
		}
		expect(verificationFailureMessage("ANYTHING_ELSE")).toBe(
			VERIFICATION_FAILURE_MESSAGES.UNAVAILABLE,
		);
	});

	test("builds a bounded result and clamps the retry delay", () => {
		const rateLimited = verificationFailure("RATE_LIMITED", 12.9);
		expect(rateLimited.ok).toBe(false);
		if (rateLimited.ok) throw new Error("expected a failure");
		expect(rateLimited.error.code).toBe("RATE_LIMITED");
		expect(rateLimited.error.message).toBe(
			VERIFICATION_FAILURE_MESSAGES.RATE_LIMITED,
		);
		expect(rateLimited.error.retryAfterSeconds).toBe(12);

		const excessive = verificationFailure("UNAVAILABLE", 99_999);
		if (excessive.ok) throw new Error("expected a failure");
		expect(excessive.error.retryAfterSeconds).toBe(3_600);

		for (const invalid of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
			const failure = verificationFailure("UNAVAILABLE", invalid);
			if (failure.ok) throw new Error("expected a failure");
			expect(failure.error.retryAfterSeconds).toBeUndefined();
		}
	});
});

describe("connection status semantics", () => {
	test("only pending_validation, invalid and active can be verified", () => {
		expect(isVerifiableStatus("pending_validation")).toBe(true);
		expect(isVerifiableStatus("invalid")).toBe(true);
		expect(isVerifiableStatus("active")).toBe(true);
		expect(isVerifiableStatus("revoked")).toBe(false);
		expect(isVerifiableStatus("unknown")).toBe(false);
	});

	test("Connected is reserved for an active credential", () => {
		expect(verificationStatusLabel("active")).toBe("Connected");
		expect(verificationStatusLabel("pending_validation")).toBe(
			"Verification pending",
		);
		expect(verificationStatusLabel("invalid")).toBe("Verification failed");
		expect(verificationStatusLabel("revoked")).not.toBe("Connected");
		expect(verificationStatusLabel("unknown")).not.toBe("Connected");
	});

	test("a pending credential is described as not production-ready", () => {
		const pending = verificationStatusCopy("pending_validation");
		expect(pending.label).toContain("pending");
		expect(pending.description).toContain("not production-ready");
		expect(verificationStatusLabel("invalid")).toContain("failed");
	});

	test("pairing completion never claims a verified connection", () => {
		expect(PAIRING_STATUS_LABELS.completed).toBe("Stored on relay");
		expect(PAIRING_STATUS_LABELS.completed).not.toContain("Connected");
	});
});

describe("autoVerificationCredentialId", () => {
	test("asks for exactly one read once pairing stores a credential", () => {
		const session = { status: "completed", credentialId: CREDENTIAL_ID };
		expect(autoVerificationCredentialId(session, null)).toBe(CREDENTIAL_ID);
		expect(autoVerificationCredentialId(session, CREDENTIAL_ID)).toBeNull();
	});

	test("does nothing before completion or without a credential id", () => {
		expect(
			autoVerificationCredentialId(
				{ status: "pending", credentialId: CREDENTIAL_ID },
				null,
			),
		).toBeNull();
		expect(
			autoVerificationCredentialId(
				{ status: "claimed", credentialId: CREDENTIAL_ID },
				null,
			),
		).toBeNull();
		expect(autoVerificationCredentialId({ status: "completed" }, null)).toBe(
			null,
		);
		expect(autoVerificationCredentialId(undefined, null)).toBeNull();
	});
});
