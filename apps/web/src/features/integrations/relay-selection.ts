import {
	type DeviceView,
	RELAY_OFFLINE_AFTER_MS,
} from "@/features/devices/contracts";

/**
 * Relay choice for the pairing form.
 *
 * A stored `active` status is not liveness: the row stays active after the
 * daemon stops. The server refreshes `last_seen_at` at most about once a
 * minute, so a heartbeat inside `RELAY_OFFLINE_AFTER_MS` is the only evidence
 * this module uses to prefer one active relay over another. Selection is
 * ordering metadata only; the server still binds a pairing code to the chosen
 * relay id and rejects a claim from any other device.
 */

export type PairingRelay = Pick<
	DeviceView,
	"id" | "displayName" | "lastSeenAt" | "status"
>;

export type RelayFreshness = "online" | "stale" | "unknown";

/**
 * A heartbeat further in the future than this cannot be trusted as liveness
 * (browser and server clocks disagree); it is treated as unknown rather than
 * being reported as a recent heartbeat.
 */
export const RELAY_CLOCK_SKEW_TOLERANCE_MS = 60_000;

export type RelayChoice = {
	readonly relay: PairingRelay;
	readonly freshness: RelayFreshness;
	/** Parsed heartbeat time, or null when missing or untrustworthy. */
	readonly lastSeenMs: number | null;
};

/** Parses an ISO heartbeat; a missing or unparseable value yields null. */
export function parseRelayLastSeen(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Freshness at one instant. `nowMs` is null before the client has measured
 * "now" (server render and first hydration pass), so nothing is asserted then.
 */
export function relayFreshness(
	lastSeenMs: number | null,
	nowMs: number | null,
): RelayFreshness {
	if (lastSeenMs === null || nowMs === null) return "unknown";
	const age = nowMs - lastSeenMs;
	if (age < -RELAY_CLOCK_SKEW_TOLERANCE_MS) return "unknown";
	return age <= RELAY_OFFLINE_AFTER_MS ? "online" : "stale";
}

/**
 * Active relays only, most recent trustworthy heartbeat first. Entries without
 * a trustworthy timestamp follow in their server order; exact ties also keep
 * server order (`Array.prototype.sort` is stable). The display name never
 * influences the order or the default choice.
 */
export function relayChoices(
	relays: readonly PairingRelay[],
	nowMs: number | null,
): RelayChoice[] {
	const choices = relays
		.filter((relay) => relay.status === "active")
		.map((relay) => {
			const parsed = parseRelayLastSeen(relay.lastSeenAt);
			const trustworthy =
				parsed !== null &&
				(nowMs === null || parsed <= nowMs + RELAY_CLOCK_SKEW_TOLERANCE_MS);
			const lastSeenMs = trustworthy ? parsed : null;
			return {
				relay,
				freshness: relayFreshness(lastSeenMs, nowMs),
				lastSeenMs,
			};
		});
	return choices.sort((left, right) => {
		if (left.lastSeenMs === null && right.lastSeenMs === null) return 0;
		if (left.lastSeenMs === null) return 1;
		if (right.lastSeenMs === null) return -1;
		return right.lastSeenMs - left.lastSeenMs;
	});
}

/** The relay the form proposes: the first choice in preference order. */
export function defaultRelayId(choices: readonly RelayChoice[]): string | null {
	return choices[0]?.relay.id ?? null;
}

const FRESHNESS_WINDOW_MINUTES = Math.round(RELAY_OFFLINE_AFTER_MS / 60_000);

/** Option text. It states measured heartbeat age, never "online". */
export function relayOptionLabel(
	choice: RelayChoice,
	nowMs: number | null,
): string {
	const name = choice.relay.displayName;
	if (nowMs === null) return name;
	if (choice.freshness === "online") {
		return `${name} — heartbeat within ${FRESHNESS_WINDOW_MINUTES} min`;
	}
	if (choice.freshness === "stale") {
		return `${name} — heartbeat older than ${FRESHNESS_WINDOW_MINUTES} min`;
	}
	return `${name} — no heartbeat data`;
}

/**
 * One fixed sentence for the current manual or proposed choice, or null when
 * the choice needs no qualification. It never claims a relay is online beyond
 * the heartbeat window and never mentions pairing internals.
 */
export function relaySelectionHint({
	choices,
	selectedId,
	nowMs,
}: {
	choices: readonly RelayChoice[];
	selectedId: string | null;
	nowMs: number | null;
}): string | null {
	if (nowMs === null) return null;
	const selected = choices.find((choice) => choice.relay.id === selectedId);
	if (selected === undefined) return null;
	const fresh = choices.filter((choice) => choice.freshness === "online");
	if (selected.freshness === "unknown") {
		return `Isolate has no reliable heartbeat for ${selected.relay.displayName}, so it cannot tell whether that relay daemon is running. Check which relay you started before connecting.`;
	}
	if (selected.freshness === "stale") {
		const fresher = fresh[0];
		if (fresher !== undefined) {
			return `${fresher.relay.displayName} has a heartbeat from the last ${FRESHNESS_WINDOW_MINUTES} minutes and ${selected.relay.displayName} does not. Check which relay daemon you started.`;
		}
		return `No active relay has a heartbeat from the last ${FRESHNESS_WINDOW_MINUTES} minutes. ${selected.relay.displayName} is only the most recently seen. Check which relay daemon you started.`;
	}
	if (fresh.length > 1) {
		return `${fresh.length} relays have a recent heartbeat, so Isolate cannot tell which daemon you started. Choose that relay explicitly.`;
	}
	return null;
}
