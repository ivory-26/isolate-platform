import {
	boundedTraceAttributes,
	type TraceEvent,
	type TraceSink,
} from "./trace";

/**
 * Opt-in OTLP/HTTP JSON trace exporter.
 *
 * Converts the bounded `TraceEvent` stream into one OTLP `ExportTraceService`
 * request per span and POSTs it to a collector. The exporter is deliberately
 * dependency-free: OTLP/HTTP JSON is a plain JSON document, so no vendor SDK
 * (and no second credentials path) is added.
 *
 * Safety invariants:
 * - the endpoint must be https; plain http is accepted only for a loopback
 *   host used by a local collector;
 * - the endpoint may not embed userinfo, a query or a fragment, so a token can
 *   never travel in the URL (and never be logged);
 * - headers are sent on the request only and never copied into the payload;
 * - every span is bounded again (16 attributes, 128-char values) and an event
 *   with a malformed id or name is dropped;
 * - `emit` is fire-and-forget: it never throws, never awaits and never
 *   surfaces a network failure to the tracer or the task;
 * - nothing here logs, so an endpoint or header value cannot reach a log line.
 */

export type OtlpTraceSinkOptions = {
	/** Collector base URL (gets `/v1/traces`) or the full signal URL. */
	endpoint: string;
	/** Extra request headers (for example an authorization header). */
	headers?: Readonly<Record<string, string>>;
	/** Test seam; defaults to the runtime `fetch`. */
	fetchImpl?: typeof fetch;
	/** Abort budget for one export; floor 100 ms, ceiling 30 s. */
	timeoutMs?: number;
};

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const SPAN_NAME_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const OTLP_TRACES_PATH = "/v1/traces";
const NANOS_PER_MILLI = 1_000_000n;
const MAX_DURATION_MS = 86_400_000;
const MAX_HEADERS = 8;
const MAX_HEADER_VALUE_CHARS = 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const SERVICE_NAME = "isolate-platform";
const SCOPE_NAME = "isolate.observability.trace";

/** OTLP/JSON `AnyValue`; int64 values are strings by the OTLP JSON mapping. */
type OtlpAnyValue =
	| { stringValue: string }
	| { intValue: string }
	| { doubleValue: number }
	| { boolValue: boolean };

type OtlpSpanStatus = { code: 1 | 2 };

/** OTLP span status: 1 = OK, 2 = ERROR (0 UNSET is never emitted). */
function otlpStatus(status: TraceEvent["status"]): OtlpSpanStatus {
	return status === "ok" ? { code: 1 } : { code: 2 };
}

function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "[::1]" ||
		hostname === "::1"
	);
}

/**
 * Validates the endpoint and resolves the traces path.
 *
 * Throws a fixed message (never the endpoint itself) so a misconfigured worker
 * fails closed at boot without echoing a credential that a URL might carry.
 */
export function resolveOtlpTraceEndpoint(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("OTLP endpoint must be an absolute URL");
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw new Error("OTLP endpoint must not carry credentials");
	}
	if (url.search.length > 0 || url.hash.length > 0) {
		throw new Error("OTLP endpoint must not carry a query or fragment");
	}
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && isLoopbackHost(url.hostname))
	) {
		throw new Error(
			"OTLP endpoint must use https (http is allowed only for localhost)",
		);
	}
	if (url.pathname === "" || url.pathname === "/") {
		url.pathname = OTLP_TRACES_PATH;
	}
	return url.toString();
}

/** Bounds the header set; a malformed pair is skipped, never logged. */
export function boundedOtlpHeaders(
	headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
	if (headers === undefined) return {};
	const entries: Array<[string, string]> = [];
	let count = 0;
	for (const [key, value] of Object.entries(headers)) {
		if (count >= MAX_HEADERS) break;
		if (!HEADER_NAME_PATTERN.test(key)) continue;
		if (typeof value !== "string" || value.length === 0) continue;
		const lowered = key.toLowerCase();
		if (entries.some(([existing]) => existing.toLowerCase() === lowered)) {
			continue;
		}
		entries.push([key, value.slice(0, MAX_HEADER_VALUE_CHARS)]);
		count += 1;
	}
	return Object.fromEntries(entries);
}

/** Unix epoch nanoseconds for an ISO timestamp; `null` when unparsable. */
function startTimeUnixNano(startedAt: string): bigint | null {
	const millis = Date.parse(startedAt);
	if (!Number.isFinite(millis) || millis < 0) return null;
	return BigInt(Math.floor(millis)) * NANOS_PER_MILLI;
}

/** Nanoseconds for a bounded, non-negative duration. */
function durationNanos(durationMs: number): bigint {
	const bounded = Number.isFinite(durationMs)
		? Math.max(0, Math.min(MAX_DURATION_MS, durationMs))
		: 0;
	const whole = Math.floor(bounded);
	const fractionNanos = Math.round((bounded - whole) * 1_000_000);
	return BigInt(whole) * NANOS_PER_MILLI + BigInt(fractionNanos);
}

function otlpAnyValue(value: string | number | boolean): OtlpAnyValue {
	if (typeof value === "boolean") return { boolValue: value };
	if (typeof value === "number") {
		return Number.isInteger(value)
			? { intValue: value.toString() }
			: { doubleValue: value };
	}
	return { stringValue: value };
}

function otlpAttributes(
	attributes: Readonly<Record<string, string | number | boolean>>,
): Array<{ key: string; value: OtlpAnyValue }> {
	return Object.entries(attributes).map(([key, value]) => ({
		key,
		value: otlpAnyValue(value),
	}));
}

/**
 * Builds the OTLP/HTTP JSON document for one bounded span.
 *
 * Returns `null` for an event this exporter must not send: a malformed id or
 * span name means the record did not come from `trace.ts`.
 */
export function otlpTracePayload(
	event: TraceEvent,
): Record<string, unknown> | null {
	if (
		!TRACE_ID_PATTERN.test(event.traceId) ||
		!SPAN_ID_PATTERN.test(event.spanId) ||
		!SPAN_NAME_PATTERN.test(event.name)
	) {
		return null;
	}
	if (
		event.parentSpanId !== null &&
		!SPAN_ID_PATTERN.test(event.parentSpanId)
	) {
		return null;
	}
	const startNanos = startTimeUnixNano(event.startedAt);
	if (startNanos === null) return null;
	const endNanos = startNanos + durationNanos(event.durationMs);
	const attributes = otlpAttributes(boundedTraceAttributes(event.attributes));
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{
							key: "service.name",
							value: { stringValue: SERVICE_NAME },
						},
					],
				},
				scopeSpans: [
					{
						scope: { name: SCOPE_NAME },
						spans: [
							{
								traceId: event.traceId,
								spanId: event.spanId,
								...(event.parentSpanId === null
									? {}
									: { parentSpanId: event.parentSpanId }),
								name: event.name,
								kind: 1,
								startTimeUnixNano: startNanos.toString(),
								endTimeUnixNano: endNanos.toString(),
								status: otlpStatus(event.status),
								attributes,
							},
						],
					},
				],
			},
		],
	};
}

/** Clamps the export timeout to a bounded budget. */
function boundedTimeoutMs(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
		return DEFAULT_TIMEOUT_MS;
	}
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs));
}

/**
 * Fire-and-forget OTLP/HTTP JSON exporter for the `TraceEvent` stream.
 *
 * `emit` serializes and starts one export without awaiting it. A rejected
 * fetch, a non-2xx response, a JSON failure or an aborted timeout are all
 * swallowed: tracing must never change a task's outcome.
 */
export function createOtlpTraceSink(options: OtlpTraceSinkOptions): TraceSink {
	const url = resolveOtlpTraceEndpoint(options.endpoint);
	const headers = {
		"content-type": "application/json",
		...boundedOtlpHeaders(options.headers),
	};
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = boundedTimeoutMs(options.timeoutMs);

	const send = async (payload: Record<string, unknown>): Promise<void> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
		} catch {
			// Network failure, abort or a non-fetch error: dropped by design.
		} finally {
			clearTimeout(timer);
		}
	};

	return {
		emit(event) {
			try {
				const payload = otlpTracePayload(event);
				if (payload === null) return;
				void send(payload).catch(() => {
					// `send` already swallows; this guards the promise chain.
				});
			} catch {
				// Serialization must never reach the caller.
			}
		},
	};
}

/**
 * Fans one event out to several sinks. Each sink is isolated: a throwing sink
 * cannot stop the next one, so adding the OTLP exporter never silences the
 * logger (or the reverse).
 */
export function createMultiTraceSink(sinks: readonly TraceSink[]): TraceSink {
	const active = [...sinks];
	return {
		emit(event) {
			for (const sink of active) {
				try {
					sink.emit(event);
				} catch {
					// One broken sink is not allowed to break the others.
				}
			}
		},
	};
}
