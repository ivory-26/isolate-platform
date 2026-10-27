import { expect, test } from "bun:test";
import {
	ACK_FAIL_BACKOFF_CAP_SECONDS,
	ackFailOutcome,
} from "./queue-repository";

test("ackFailOutcome dead-letters once attempts reaches maxAttempts", () => {
	expect(ackFailOutcome(3, 3)).toEqual({
		requeued: false,
		status: "dead_letter",
		backoffSeconds: null,
	});
	expect(ackFailOutcome(5, 2)).toEqual({
		requeued: false,
		status: "dead_letter",
		backoffSeconds: null,
	});
});

test("ackFailOutcome requeues below the limit with exponential backoff", () => {
	expect(ackFailOutcome(0, 3)).toEqual({
		requeued: true,
		status: "pending",
		backoffSeconds: 1,
	});
	expect(ackFailOutcome(1, 3)).toEqual({
		requeued: true,
		status: "pending",
		backoffSeconds: 2,
	});
	expect(ackFailOutcome(2, 3)).toEqual({
		requeued: true,
		status: "pending",
		backoffSeconds: 4,
	});
});

test("ackFailOutcome caps backoff at the configured ceiling", () => {
	// 2^10 = 1024 but the cap is 300 seconds.
	expect(ackFailOutcome(10, 11)?.backoffSeconds).toBe(
		ACK_FAIL_BACKOFF_CAP_SECONDS,
	);
	expect(ackFailOutcome(0, 11)?.backoffSeconds).toBe(1);
});

test("ackFailOutcome treats a bogus maxAttempts as at least one attempt", () => {
	// maxAttempts = 0 clamps to 1: the FIRST failure (attempts 1) dead-letters.
	expect(ackFailOutcome(1, 0).status).toBe("dead_letter");
	// attempts 0 is still below the clamped limit, so one requeue remains.
	expect(ackFailOutcome(0, -5)).toEqual({
		requeued: true,
		status: "pending",
		backoffSeconds: 1,
	});
});
