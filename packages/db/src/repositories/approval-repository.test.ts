import { expect, test } from "bun:test";
import { evaluateDecisionOutcome } from "./approval-repository";

test("decide on a missing approval is NOT_FOUND", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: null,
			expiresAtMs: null,
			nowMs: 1000,
			payloadSha256Match: true,
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
});

test("decide on an already-expired row is APPROVAL_EXPIRED", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "expired",
			expiresAtMs: null,
			nowMs: 1000,
			payloadSha256Match: true,
		}),
	).toEqual({ ok: false, code: "APPROVAL_EXPIRED" });
});

test("decide on a decided row is ALREADY_DECIDED", () => {
	for (const status of ["approved", "rejected"] as const) {
		expect(
			evaluateDecisionOutcome({
				currentStatus: status,
				expiresAtMs: null,
				nowMs: 1000,
				payloadSha256Match: true,
			}),
		).toEqual({ ok: false, code: "ALREADY_DECIDED" });
	}
});

test("decide with a mismatched payload hash is PAYLOAD_CHANGED", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "pending",
			expiresAtMs: 2000,
			nowMs: 1000,
			payloadSha256Match: false,
		}),
	).toEqual({ ok: false, code: "PAYLOAD_CHANGED" });
});

test("decide on a pending-but-past-expiry row is APPROVAL_EXPIRED", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "pending",
			expiresAtMs: 1000,
			nowMs: 1001,
			payloadSha256Match: true,
		}),
	).toEqual({ ok: false, code: "APPROVAL_EXPIRED" });
});

test("expiry boundary is inclusive: expires_at == now is expired", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "pending",
			expiresAtMs: 1000,
			nowMs: 1000,
			payloadSha256Match: true,
		}).ok,
	).toBe(false);
});

test("happy path: pending, exact hash, not expired => ok", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "pending",
			expiresAtMs: 2000,
			nowMs: 1000,
			payloadSha256Match: true,
		}),
	).toEqual({ ok: true });
});
