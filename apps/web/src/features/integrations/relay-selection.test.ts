import { describe, expect, test } from "bun:test";
import { RELAY_OFFLINE_AFTER_MS } from "@/features/devices/contracts";
import {
	defaultRelayId,
	type PairingRelay,
	parseRelayLastSeen,
	relayChoices,
	relayFreshness,
	relayOptionLabel,
	relaySelectionHint,
} from "./relay-selection";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const WINDOW_MINUTES = Math.round(RELAY_OFFLINE_AFTER_MS / 60_000);

function at(offsetMs: number): string {
	return new Date(NOW + offsetMs).toISOString();
}

function relay(
	id: string,
	overrides: Partial<Omit<PairingRelay, "id">> = {},
): PairingRelay {
	return {
		id,
		displayName: id,
		status: "active",
		lastSeenAt: at(-60_000),
		...overrides,
	};
}

describe("relayChoices", () => {
	test("prefers the most recently seen active relay, not the first row", () => {
		// The measured defect: the stale registration was first, the running
		// relay second, and a fixed index picked the stale one.
		const stale = relay("local", {
			displayName: "Local daemon",
			lastSeenAt: at(-30 * 60_000),
		});
		const running = relay("verification", {
			displayName: "Verification relay",
			lastSeenAt: at(-60_000),
		});
		const choices = relayChoices([stale, running], NOW);
		expect(choices.map((choice) => choice.relay.id)).toEqual([
			"verification",
			"local",
		]);
		expect(defaultRelayId(choices)).toBe("verification");
	});

	test("never selects by display name", () => {
		const a = relay("a", { displayName: "Verification relay" });
		const b = relay("b", {
			displayName: "Local daemon",
			lastSeenAt: at(-5_000),
		});
		expect(defaultRelayId(relayChoices([a, b], NOW))).toBe("b");
		expect(defaultRelayId(relayChoices([b, a], NOW))).toBe("b");
	});

	test("drops pending and revoked relays", () => {
		const choices = relayChoices(
			[
				relay("pending", { status: "pending" }),
				relay("revoked", { status: "revoked" }),
				relay("active"),
			],
			NOW,
		);
		expect(choices.map((choice) => choice.relay.id)).toEqual(["active"]);
	});

	test("has no default when nothing is active", () => {
		expect(relayChoices([], NOW)).toEqual([]);
		expect(defaultRelayId(relayChoices([], NOW))).toBeNull();
	});

	test("orders a trustworthy heartbeat above missing and invalid ones", () => {
		const choices = relayChoices(
			[
				relay("never", { lastSeenAt: null }),
				relay("invalid", { lastSeenAt: "not-a-timestamp" }),
				relay("seen", { lastSeenAt: at(-2 * 60_000) }),
			],
			NOW,
		);
		expect(choices.map((choice) => choice.relay.id)).toEqual([
			"seen",
			"never",
			"invalid",
		]);
		expect(choices[0]?.freshness).toBe("online");
		expect(choices[1]?.freshness).toBe("unknown");
	});

	test("keeps server order for equal and missing heartbeats", () => {
		const same = at(-60_000);
		const choices = relayChoices(
			[
				relay("first", { lastSeenAt: same }),
				relay("second", { lastSeenAt: same }),
				relay("third", { lastSeenAt: null }),
				relay("fourth", { lastSeenAt: null }),
			],
			NOW,
		);
		expect(choices.map((choice) => choice.relay.id)).toEqual([
			"first",
			"second",
			"third",
			"fourth",
		]);
	});

	test("picks the most recently seen relay when none is inside the window", () => {
		const choices = relayChoices(
			[
				relay("older", { lastSeenAt: at(-40 * 60_000) }),
				relay("newer", { lastSeenAt: at(-10 * 60_000) }),
				relay("unknown", { lastSeenAt: null }),
			],
			NOW,
		);
		expect(choices.every((choice) => choice.freshness !== "online")).toBe(true);
		expect(defaultRelayId(choices)).toBe("newer");
	});

	test("treats an implausible future heartbeat as unknown, not online", () => {
		const choices = relayChoices(
			[relay("future", { lastSeenAt: at(10 * 60_000) })],
			NOW,
		);
		expect(choices[0]?.freshness).toBe("unknown");
		expect(choices[0]?.lastSeenMs).toBeNull();
	});

	test("accepts small clock skew as a heartbeat", () => {
		const choices = relayChoices(
			[relay("skewed", { lastSeenAt: at(30_000) })],
			NOW,
		);
		expect(choices[0]?.freshness).toBe("online");
	});

	test("asserts no freshness before the client measures now", () => {
		const choices = relayChoices(
			[
				relay("first", { lastSeenAt: null }),
				relay("second", { lastSeenAt: at(-60_000) }),
			],
			null,
		);
		expect(choices.map((choice) => choice.relay.id)).toEqual([
			"second",
			"first",
		]);
		expect(choices.every((choice) => choice.freshness === "unknown")).toBe(
			true,
		);
		const first = choices[0];
		expect(first === undefined ? null : relayOptionLabel(first, null)).toBe(
			"second",
		);
		expect(
			relaySelectionHint({
				choices,
				selectedId: "first",
				nowMs: null,
			}),
		).toBeNull();
	});
});

describe("relayFreshness", () => {
	test("classifies around the offline window boundary", () => {
		expect(relayFreshness(NOW - RELAY_OFFLINE_AFTER_MS, NOW)).toBe("online");
		expect(relayFreshness(NOW - RELAY_OFFLINE_AFTER_MS - 1, NOW)).toBe("stale");
		expect(relayFreshness(null, NOW)).toBe("unknown");
		expect(relayFreshness(NOW, null)).toBe("unknown");
	});
});

describe("parseRelayLastSeen", () => {
	test("rejects missing and unparseable values", () => {
		expect(parseRelayLastSeen(null)).toBeNull();
		expect(parseRelayLastSeen("")).toBeNull();
		expect(parseRelayLastSeen("12:00")).toBeNull();
		expect(parseRelayLastSeen(at(0))).toBe(NOW);
	});
});

describe("relaySelectionHint", () => {
	const fresh = relay("fresh", {
		displayName: "Verification relay",
		lastSeenAt: at(-60_000),
	});
	const stale = relay("stale", {
		displayName: "Local daemon",
		lastSeenAt: at(-20 * 60_000),
	});

	function hintFor(
		relays: readonly PairingRelay[],
		selectedId: string,
	): string | null {
		return relaySelectionHint({
			choices: relayChoices(relays, NOW),
			selectedId,
			nowMs: NOW,
		});
	}

	test("says nothing when the only fresh relay is selected", () => {
		expect(hintFor([fresh], "fresh")).toBeNull();
	});

	test("names the fresh alternative when a stale relay is selected", () => {
		const hint = hintFor([stale, fresh], "stale");
		expect(hint).toContain("Verification relay");
		expect(hint).toContain("Local daemon");
		expect(hint).toContain(`last ${WINDOW_MINUTES} minutes`);
		expect(hint).not.toContain("online");
	});

	test("says no relay is inside the window when none is fresh", () => {
		const hint = hintFor([stale], "stale");
		expect(hint).toContain("No active relay has a heartbeat");
		expect(hint).toContain("most recently seen");
	});

	test("admits it cannot tell when the heartbeat is missing", () => {
		const hint = hintFor([relay("never", { lastSeenAt: null })], "never");
		expect(hint).toContain("no reliable heartbeat");
		expect(hint).toContain("cannot tell");
	});

	test("asks for an explicit choice when several relays are fresh", () => {
		const hint = hintFor(
			[
				fresh,
				relay("second", {
					displayName: "Second relay",
					lastSeenAt: at(-2 * 60_000),
				}),
			],
			"fresh",
		);
		expect(hint).toContain("2 relays have a recent heartbeat");
		expect(hint).toContain("cannot tell");
	});

	test("says nothing for an unknown selection", () => {
		expect(hintFor([fresh], "missing")).toBeNull();
	});
});
