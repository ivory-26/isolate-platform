import { describe, expect, test } from "bun:test";
import type { Logger } from "../logging/logger";
import {
	boundedTraceAttributes,
	childTraceContext,
	createLoggerTraceSink,
	createMemoryTraceSink,
	createRunTracer,
	formatTraceparent,
	newTraceContext,
	parseTraceparent,
	traceLogFields,
} from "./trace";

describe("trace context", () => {
	test("creates valid non-zero identifiers and a traceparent round-trip", () => {
		const context = newTraceContext();
		expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(context.traceId).not.toBe("0".repeat(32));
		const header = formatTraceparent(context);
		expect(parseTraceparent(header)?.traceId).toBe(context.traceId);
		expect(parseTraceparent(header)?.spanId).toBe(context.spanId);
	});

	test("rejects malformed and zero traceparents", () => {
		for (const value of [
			"",
			"garbage",
			"00-00000000000000000000000000000000-0000000000000000-01",
			"01-11111111111111111111111111111111-2222222222222222-01",
			"00-1111111111111111111111111111111-2222222222222222-01",
		]) {
			expect(parseTraceparent(value)).toBeNull();
		}
	});

	test("child spans share the trace and point at the parent", () => {
		const root = newTraceContext();
		const child = childTraceContext(root);
		expect(child.traceId).toBe(root.traceId);
		expect(child.spanId).not.toBe(root.spanId);
		expect(child.parentSpanId).toBe(root.spanId);
		expect(traceLogFields(child)).toEqual({
			traceId: root.traceId,
			spanId: child.spanId,
		});
	});
});

describe("bounded trace attributes", () => {
	test("drops credential-shaped keys and unbounded values", () => {
		expect(
			boundedTraceAttributes({
				tool: "sentry.list_issues",
				count: 3,
				ok: true,
				authorization: "Bearer abc",
				prompt: "secret prompt",
				body: "<html>",
				huge: "x".repeat(400),
				"bad key": "value",
				nested: { a: 1 },
			}),
		).toEqual({ count: 3, ok: true, tool: "sentry.list_issues" });
	});

	test("caps the attribute count", () => {
		const many = Object.fromEntries(
			Array.from({ length: 40 }, (_, index) => [`k${index}`, index]),
		);
		expect(Object.keys(boundedTraceAttributes(many)).length).toBe(16);
	});
});

describe("run tracer", () => {
	test("emits spans with the run trace id and bounded duration", async () => {
		const sink = createMemoryTraceSink();
		let clock = 1_000;
		const root = newTraceContext();
		const tracer = createRunTracer(root, {
			sink,
			now: () => clock,
		});
		const value = await tracer.withSpan(
			"connector.enqueue",
			{ tool: "sentry.list_issues", count: 1 },
			async () => {
				clock += 25;
				return "ok";
			},
		);
		expect(value).toBe("ok");
		expect(sink.events).toHaveLength(1);
		const event = sink.events[0];
		expect(event?.traceId).toBe(root.traceId);
		expect(event?.parentSpanId).toBe(root.spanId);
		expect(event?.durationMs).toBe(25);
		expect(event?.status).toBe("ok");
		expect(event?.attributes).toEqual({ count: 1, tool: "sentry.list_issues" });
	});

	test("records an error status without emitting the error value", async () => {
		const sink = createMemoryTraceSink();
		const tracer = createRunTracer(newTraceContext(), { sink });
		await expect(
			tracer.withSpan("tool.gate", undefined, async () => {
				throw new Error("secret provider detail");
			}),
		).rejects.toThrow("secret provider detail");
		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.status).toBe("error");
		expect(JSON.stringify(sink.events)).not.toContain("secret provider detail");
	});
});

describe("logger sink", () => {
	test("streams isolate.trace records through the redacting logger", () => {
		const records: Array<{
			message: string;
			fields?: Record<string, unknown>;
		}> = [];
		const logger: Logger = {
			debug() {},
			info(message, fields) {
				records.push({ message, fields });
			},
			warn() {},
			error() {},
			child() {
				return logger;
			},
		};
		const sink = createLoggerTraceSink(logger);
		sink.emit({
			name: "connector.claim",
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			parentSpanId: null,
			startedAt: new Date(0).toISOString(),
			durationMs: 12,
			status: "ok",
			attributes: { tool: "k8s.list_events" },
		});
		expect(records).toHaveLength(1);
		expect(records[0]?.message).toBe("isolate.trace");
		expect(records[0]?.fields).toMatchObject({
			span: "connector.claim",
			durationMs: 12,
			tool: "k8s.list_events",
		});
	});
});
