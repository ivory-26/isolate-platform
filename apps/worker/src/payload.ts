/**
 * Bounded readers for untrusted job payloads.
 *
 * Handlers receive `job.payload` from the queue (at-least-once, possibly
 * stale or hostile). These readers never throw — a hostile getter or a proxy
 * must not turn `supports()` into an exception — and they accept only the
 * exact bounded shapes the worker itself enqueues.
 */

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bounded approval id: opaque, single component, no control characters. */
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readStringField(payload: unknown, field: string): unknown {
	if (payload === null || typeof payload !== "object") return null;
	if (Array.isArray(payload)) return null;
	return (payload as Record<string, unknown>)[field];
}

/** Reads a UUID taskId from an untrusted payload without throwing. */
export function readTaskId(payload: unknown): string | null {
	try {
		const value = readStringField(payload, "taskId");
		return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
	} catch {
		// Hostile getters/proxies must never make `supports()` throw.
		return null;
	}
}

/** Reads the bounded approval id from an untrusted payload without throwing. */
export function readApprovalId(payload: unknown): string | null {
	try {
		const value = readStringField(payload, "approvalId");
		return typeof value === "string" && APPROVAL_ID_PATTERN.test(value)
			? value
			: null;
	} catch {
		return null;
	}
}
