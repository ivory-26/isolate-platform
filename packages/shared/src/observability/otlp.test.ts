import { describe, expect, test } from "bun:test";
import {
	boundedOtlpHeaders,
	createMultiTraceSink,
	createOtlpTraceSink,
	otlpTracePayload,
	resolveOtlpTraceEndpoint,
} from "./otlp";
import { createMemoryTraceSink, type TraceEvent } from "./trace";

const TRACE_ID = "1".repeat(32);
const SPAN_ID = "2".repeat(16);
const PARENT_SPAN_ID = "3".repeat(16);

type Captured = { url: string; init: RequestInit };

function event(overrides: Partial<TraceEvent> = {}): TraceEvent {
	return {
		name: "agent.turn",
		traceId: TRACE_ID,
		spanId: SPAN_ID,
		parentSpanId: PARENT_SPAN_ID,
		startedAt: "2026-01-01T00:00:00.000Z",
		durationMs: 250,
		status: "ok",
		attributes: { tool: "sentry.list_issues", count: 3, ok: true },
		...overrides,
	};
}

function captureSink(options: { status?: number; reject?: boolean } = {}): {
	sink: ReturnType<typeof createOtlpTraceSink>;
	calls: Captured[];
} {
	const calls: Captured[] = [];
	const fetchImpl = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		calls.push({ url: String(input), init: init ?? {} });
		if (options.reject === true) throw new Error("collector down");
		return new Response("{}", { status: options.status ?? 200 });
	}) as typeof fetch;
	return {
		sink: createOtlpTraceSink({
			endpoint: "https://collector.example.com",
			fetchImpl,
		}),
		calls,
	};
}

type OtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	status: { code: number };
	attributes: Array<{ key: string; value: Record<string, unknown> }>;
};

function readSpan(payload: Record<string, unknown>): OtlpSpan {
	const resourceSpans = payload.resourceSpans as Array<Record<string, unknown>>;
	const scopeSpans = resourceSpans[0]?.scopeSpans as Array<
		Record<string, unknown>
	>;
	const spans = scopeSpans[0]?.spans as OtlpSpan[];
	const span = spans[0];
	if (span === undefined) throw new Error("payload has no span");
	return span;
}

describe("otlp request shape", () => {
	test("converts one trace event into one resource/scope/span document", () => {
		const { sink, calls } = captureSink();
		sink.emit(event());
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url).toBe("https://collector.example.com/v1/traces");
		expect(call?.init.method).toBe("POST");
		expect((call?.init.headers as Record<string, string>)["content-type"]).toBe(
			"application/json",
		);
		const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
		const resourceSpans = body.resourceSpans as Array<Record<string, unknown>>;
		expect(resourceSpans).toHaveLength(1);
		const resource = resourceSpans[0]?.resource as {
			attributes: Array<{ key: string; value: Record<string, unknown> }>;
		};
		expect(resource.attributes[0]?.key).toBe("service.name");
		const span = readSpan(body);
		expect(span.traceId).toBe(TRACE_ID);
		expect(span.spanId).toBe(SPAN_ID);
		expect(span.parentSpanId).toBe(PARENT_SPAN_ID);
		expect(span.name).toBe("agent.turn");
		expect(span.kind).toBe(1);
		expect(span.status).toEqual({ code: 1 });
		const attributes = Object.fromEntries(
			span.attributes.map((attribute) => [attribute.key, attribute.value]),
		);
		expect(attributes.tool).toEqual({ stringValue: "sentry.list_issues" });
		expect(attributes.count).toEqual({ intValue: "3" });
		expect(attributes.ok).toEqual({ boolValue: true });
	});

	test("encodes 64-bit nanosecond times and a measured duration", () => {
		const payload = otlpTracePayload(event({ durationMs: 250 }));
		expect(payload).not.toBeNull();
		const span = readSpan(payload as Record<string, unknown>);
		const start = BigInt(span.startTimeUnixNano);
		const end = BigInt(span.endTimeUnixNano);
		expect(start).toBe(1_767_225_600_000_000_000n);
		expect(start).toBeGreaterThan(2n ** 32n);
		expect(end - start).toBe(250_000_000n);
	});

	test("omits the parent for a root span and maps non-ok status", () => {
		const errorSpan = readSpan(
			otlpTracePayload(
				event({ parentSpanId: null, status: "error" }),
			) as Record<string, unknown>,
		);
		expect(errorSpan.parentSpanId).toBeUndefined();
		expect(errorSpan.status).toEqual({ code: 2 });
		const cancelled = readSpan(
			otlpTracePayload(event({ status: "cancelled" })) as Record<
				string,
				unknown
			>,
		);
		expect(cancelled.status).toEqual({ code: 2 });
	});

	test("caps span attributes and drops content-shaped keys", () => {
		const many = Object.fromEntries(
			Array.from({ length: 30 }, (_, index) => [`k${index}`, index]),
		);
		const span = readSpan(
			otlpTracePayload(
				event({ attributes: { ...many, token: "leak", prompt: "leak" } }),
			) as Record<string, unknown>,
		);
		expect(span.attributes).toHaveLength(16);
		expect(span.attributes.some((a) => a.key === "token")).toBe(false);
	});

	test("drops an event with a malformed id or name", () => {
		const { sink, calls } = captureSink();
		sink.emit(event({ traceId: "not-hex" }));
		sink.emit(event({ name: "Not Valid" }));
		sink.emit(event({ startedAt: "yesterday" }));
		expect(calls).toHaveLength(0);
	});
});

describe("otlp endpoint validation", () => {
	test("appends the traces path to a base URL", () => {
		expect(resolveOtlpTraceEndpoint("https://collector.example.com/")).toBe(
			"https://collector.example.com/v1/traces",
		);
		expect(
			resolveOtlpTraceEndpoint("https://collector.example.com/otlp/v1/traces"),
		).toBe("https://collector.example.com/otlp/v1/traces");
	});

	test("allows plain http only for loopback collectors", () => {
		expect(resolveOtlpTraceEndpoint("http://localhost:4318")).toBe(
			"http://localhost:4318/v1/traces",
		);
		expect(resolveOtlpTraceEndpoint("http://127.0.0.1:4318")).toBe(
			"http://127.0.0.1:4318/v1/traces",
		);
		expect(() =>
			resolveOtlpTraceEndpoint("http://collector.example.com"),
		).toThrow("https");
	});

	test("rejects a URL that could smuggle a token", () => {
		expect(() =>
			createOtlpTraceSink({
				endpoint: "https://user:token@collector.example.com",
			}),
		).toThrow("credentials");
		expect(() =>
			createOtlpTraceSink({
				endpoint: "https://collector.example.com?token=x",
			}),
		).toThrow("query");
		expect(() => createOtlpTraceSink({ endpoint: "nope" })).toThrow(
			"absolute URL",
		);
	});
});

describe("otlp failure handling", () => {
	test("swallows a rejected fetch and a non-2xx response", async () => {
		const rejected = captureSink({ reject: true });
		expect(() => rejected.sink.emit(event())).not.toThrow();
		await Bun.sleep(5);
		expect(rejected.calls).toHaveLength(1);
		const failing = captureSink({ status: 500 });
		expect(() => failing.sink.emit(event())).not.toThrow();
		await Bun.sleep(5);
		expect(failing.calls).toHaveLength(1);
	});

	test("aborts an export at the bounded timeout", async () => {
		let seen: AbortSignal | null = null;
		const fetchImpl = ((_: Parameters<typeof fetch>[0], init?: RequestInit) => {
			seen = init?.signal ?? null;
			return new Promise<Response>(() => {
				// Never settles: the abort timer owns the outcome.
			});
		}) as typeof fetch;
		const sink = createOtlpTraceSink({
			endpoint: "https://collector.example.com",
			fetchImpl,
			timeoutMs: 1,
		});
		sink.emit(event());
		await Bun.sleep(150);
		expect(seen).not.toBeNull();
		expect((seen as AbortSignal | null)?.aborted).toBe(true);
	});

	test("never puts request headers into the payload", () => {
		const calls: Captured[] = [];
		const fetchImpl = (async (
			input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			calls.push({ url: String(input), init: init ?? {} });
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const sink = createOtlpTraceSink({
			endpoint: "https://collector.example.com",
			headers: { authorization: "Bearer super-secret-token" },
			fetchImpl,
		});
		sink.emit(event());
		const body = String(calls[0]?.init.body);
		expect(body).not.toContain("super-secret-token");
		expect(body).not.toContain("authorization");
		expect(
			(calls[0]?.init.headers as Record<string, string>).authorization,
		).toBe("Bearer super-secret-token");
	});
});

describe("header bounds", () => {
	test("keeps name/value pairs and drops malformed entries", () => {
		const headers = boundedOtlpHeaders({
			authorization: "Bearer x",
			"x-tenant": "team-a",
			"bad header": "value",
			empty: "",
		});
		expect(headers).toEqual({
			authorization: "Bearer x",
			"x-tenant": "team-a",
		});
	});

	test("caps the header count", () => {
		const many = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [`x-h${index}`, "v"]),
		);
		expect(Object.keys(boundedOtlpHeaders(many))).toHaveLength(8);
	});
});

describe("multi sink", () => {
	test("delivers to every sink and isolates a throwing one", () => {
		const first = createMemoryTraceSink();
		const second = createMemoryTraceSink();
		const sink = createMultiTraceSink([
			{
				emit() {
					throw new Error("broken sink");
				},
			},
			first,
			second,
		]);
		expect(() => sink.emit(event())).not.toThrow();
		expect(first.events).toHaveLength(1);
		expect(second.events).toHaveLength(1);
	});

	test("accepts an empty sink list", () => {
		const sink = createMultiTraceSink([]);
		expect(() => sink.emit(event())).not.toThrow();
	});
});
