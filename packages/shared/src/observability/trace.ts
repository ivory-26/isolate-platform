import type { Logger } from "../logging/logger";

/**
 * Run tracing contract (W3C trace-context compatible, dependency-free).
 *
 * A task run carries one 128-bit trace id. Spans cover the worker turn, the
 * sandbox command, the connector queue wait, the device claim and the provider
 * call. The server stores/publishes only bounded identifiers and numbers —
 * never prompts, tool arguments, provider bodies or credentials.
 */

export type TraceContext = {
	/** 32 lowercase hex chars; never all zero. */
	readonly traceId: string;
	/** 16 lowercase hex chars; never all zero. */
	readonly spanId: string;
	readonly parentSpanId: string | null;
	/** W3C trace flags; `1` means sampled. */
	readonly traceFlags: number;
};

export type TraceStatus = "ok" | "error" | "cancelled";

export type TraceAttributeValue = string | number | boolean;

export type TraceEvent = {
	readonly name: string;
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId: string | null;
	readonly startedAt: string;
	readonly durationMs: number;
	readonly status: TraceStatus;
	readonly attributes: Readonly<Record<string, TraceAttributeValue>>;
};

export interface TraceSink {
	emit(event: TraceEvent): void;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const NAME_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/;
const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const ATTRIBUTE_VALUE_PATTERN = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const MAX_ATTRIBUTES = 16;
const MAX_DURATION_MS = 86_400_000;

/**
 * Attribute keys that could carry credentials or content. Dropped at the
 * boundary so a caller cannot leak through a trace attribute.
 */
const FORBIDDEN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
	"authorization",
	"token",
	"secret",
	"password",
	"apikey",
	"api_key",
	"credential",
	"prompt",
	"content",
	"body",
	"params",
	"result",
]);

function randomHex(bytes: number): string {
	const buffer = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(buffer);
	return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function isNonZeroHex(value: string): boolean {
	return !/^0+$/.test(value);
}

/** Starts a new root trace/span pair. */
export function newTraceContext(): TraceContext {
	for (;;) {
		const traceId = randomHex(16);
		const spanId = randomHex(8);
		if (isNonZeroHex(traceId) && isNonZeroHex(spanId)) {
			return { traceId, spanId, parentSpanId: null, traceFlags: 1 };
		}
	}
}

/** Creates a child span under an existing context (same trace id). */
export function childTraceContext(parent: TraceContext): TraceContext {
	for (;;) {
		const spanId = randomHex(8);
		if (isNonZeroHex(spanId) && spanId !== parent.spanId) {
			return {
				traceId: parent.traceId,
				spanId,
				parentSpanId: parent.spanId,
				traceFlags: parent.traceFlags,
			};
		}
	}
}

/** Parses a W3C `traceparent` header; returns null on any malformed value. */
export function parseTraceparent(value: string): TraceContext | null {
	const match = TRACEPARENT_PATTERN.exec(value.trim().toLowerCase());
	if (match === null) return null;
	const [, traceId, spanId, flags] = match;
	if (
		traceId === undefined ||
		spanId === undefined ||
		flags === undefined ||
		!isNonZeroHex(traceId) ||
		!isNonZeroHex(spanId)
	) {
		return null;
	}
	return {
		traceId,
		spanId,
		parentSpanId: null,
		traceFlags: Number.parseInt(flags, 16) & 0xff,
	};
}

/** Formats a context as a W3C `traceparent` value. */
export function formatTraceparent(context: TraceContext): string {
	if (
		!TRACE_ID_PATTERN.test(context.traceId) ||
		!SPAN_ID_PATTERN.test(context.spanId)
	) {
		throw new Error("invalid trace context");
	}
	const flags = Math.max(0, Math.min(255, context.traceFlags))
		.toString(16)
		.padStart(2, "0");
	return `00-${context.traceId}-${context.spanId}-${flags}`;
}

/** Log fields for correlation; identifiers only. */
export function traceLogFields(context: TraceContext): Record<string, string> {
	return { traceId: context.traceId, spanId: context.spanId };
}

export function boundedTraceAttributes(
	attributes: Readonly<Record<string, unknown>> | undefined,
): Record<string, TraceAttributeValue> {
	const out: Record<string, TraceAttributeValue> = {};
	if (attributes === undefined) return out;
	let count = 0;
	for (const [key, value] of Object.entries(attributes)) {
		if (count >= MAX_ATTRIBUTES) break;
		const normalized = key.toLowerCase();
		if (
			!ATTRIBUTE_KEY_PATTERN.test(normalized) ||
			FORBIDDEN_ATTRIBUTE_KEYS.has(normalized)
		) {
			continue;
		}
		if (typeof value === "boolean") {
			out[normalized] = value;
			count += 1;
			continue;
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			out[normalized] = Math.max(
				-MAX_DURATION_MS,
				Math.min(MAX_DURATION_MS, value),
			);
			count += 1;
			continue;
		}
		if (
			typeof value === "string" &&
			ATTRIBUTE_VALUE_PATTERN.test(value) &&
			value.length <= 128
		) {
			out[normalized] = value;
			count += 1;
		}
	}
	return out;
}

export type Span = {
	readonly context: TraceContext;
	end(
		status?: TraceStatus,
		attributes?: Readonly<Record<string, unknown>>,
	): void;
};

export type Tracer = {
	startSpan(name: string, attributes?: Readonly<Record<string, unknown>>): Span;
	withSpan<T>(
		name: string,
		attributes: Readonly<Record<string, unknown>> | undefined,
		run: (context: TraceContext) => Promise<T>,
	): Promise<T>;
};

export type TracerOptions = {
	sink: TraceSink;
	now?: () => number;
};

/**
 * Tracer bound to one run's root context. Spans share the run's trace id and
 * are parented to the root span; `withSpan` ends in `finally` and records a
 * thrown error as `status: "error"` without emitting the error value.
 */
export function createRunTracer(
	root: TraceContext,
	options: TracerOptions,
): Tracer {
	const now = options.now ?? (() => Date.now());
	const startSpan = (
		name: string,
		attributes?: Readonly<Record<string, unknown>>,
	): Span => {
		if (!NAME_PATTERN.test(name)) throw new Error("invalid span name");
		const context = childTraceContext(root);
		const startedAt = now();
		const base = boundedTraceAttributes(attributes);
		let ended = false;
		return {
			context,
			end(status = "ok", extra) {
				if (ended) return;
				ended = true;
				const durationMs = Math.max(
					0,
					Math.min(MAX_DURATION_MS, now() - startedAt),
				);
				options.sink.emit({
					name,
					traceId: context.traceId,
					spanId: context.spanId,
					parentSpanId: context.parentSpanId,
					startedAt: new Date(startedAt).toISOString(),
					durationMs,
					status,
					attributes: { ...base, ...boundedTraceAttributes(extra) },
				});
			},
		};
	};
	return {
		startSpan,
		async withSpan(name, attributes, run) {
			const span = startSpan(name, attributes);
			let failed = false;
			try {
				return await run(span.context);
			} catch (error) {
				failed = true;
				span.end("error");
				throw error;
			} finally {
				if (!failed) span.end("ok");
			}
		},
	};
}

export function createMemoryTraceSink(): TraceSink & {
	events: TraceEvent[];
} {
	const events: TraceEvent[] = [];
	return {
		events,
		emit(event) {
			events.push(event);
		},
	};
}

/** Streams bounded span records through the existing redacting logger. */
export function createLoggerTraceSink(
	logger: Logger,
	message = "isolate.trace",
): TraceSink {
	return {
		emit(event) {
			logger.info(message, {
				span: event.name,
				traceId: event.traceId,
				spanId: event.spanId,
				parentSpanId: event.parentSpanId,
				startedAt: event.startedAt,
				durationMs: event.durationMs,
				status: event.status,
				...event.attributes,
			});
		},
	};
}
