import { describe, expect, test } from "bun:test";
import { createConsoleLogger, redactFields } from "./console-logger";

function captureConsole(method: "log" | "error"): {
	lines: string[];
	restore: () => void;
} {
	const lines: string[] = [];
	const original = console[method];
	console[method] = (...data: unknown[]) => {
		lines.push(data.map((part) => String(part)).join(" "));
	};
	return {
		lines,
		restore: () => {
			console[method] = original;
		},
	};
}

describe("redactFields", () => {
	test("drops sensitive keys and records them without values", () => {
		const entry = redactFields("info", "test", "checking", {
			apiKey: "FAKE-SECRET-VALUE",
			databaseUrl: "postgres://fake/fake",
			Authorization: "Bearer FAKE",
			sessionCookie: "FAKE-COOKIE",
			providerToken: "FAKE-TOKEN",
			attempt: 2,
		});
		expect(entry.fields).toEqual({ attempt: 2 });
		expect(entry.redactedKeys).toEqual([
			"apiKey",
			"databaseUrl",
			"Authorization",
			"sessionCookie",
			"providerToken",
		]);
	});

	test("serialised entry contains no planted secret", () => {
		const entry = redactFields("warn", "test", "leak check", {
			secret: "FAKE-SECRET-VALUE",
			providerApiKey: "FAKE-SECRET-VALUE",
		});
		expect(JSON.stringify(entry)).not.toContain("FAKE");
	});

	test("passes through non-sensitive fields to keep logs useful", () => {
		const entry = redactFields("info", "test", "msg", {
			taskId: "task_1",
			status: "executing",
		});
		expect(entry.fields).toEqual({
			taskId: "task_1",
			status: "executing",
		});
	});
});

describe("createConsoleLogger", () => {
	test("emits a structured line whose child fields merge and secrets redact", () => {
		const captured = captureConsole("log");
		try {
			const logger = createConsoleLogger("test-logger").child({
				taskId: "task_1",
			});
			logger.info("hello", { apiKey: "FAKE-SECRET-VALUE" });
		} finally {
			captured.restore();
		}
		expect(captured.lines).toHaveLength(1);
		const parsed = JSON.parse(captured.lines[0]) as {
			severity: string;
			logger: string;
			message: string;
			fields: Record<string, unknown>;
			redacted: string[];
			ts: string;
		};
		expect(parsed.severity).toBe("info");
		expect(parsed.logger).toBe("test-logger");
		expect(parsed.message).toBe("hello");
		expect(parsed.fields).toEqual({ taskId: "task_1" });
		expect(parsed.redacted).toEqual(["apiKey"]);
		expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
		expect(captured.lines[0]).not.toContain("FAKE");
	});

	test("warn and error route to console.error", () => {
		const captured = captureConsole("error");
		try {
			createConsoleLogger("test-logger").error("audit", {
				secret: "FAKE-SECRET-VALUE",
			});
		} finally {
			captured.restore();
		}
		expect(captured.lines).toHaveLength(1);
		const parsed = JSON.parse(captured.lines[0]) as {
			severity: string;
			message: string;
			redacted: string[];
		};
		expect(parsed.severity).toBe("error");
		expect(parsed.message).toBe("audit");
		expect(parsed.redacted).toEqual(["secret"]);
		expect(captured.lines[0]).not.toContain("FAKE");
	});

	test("debug stays silent without ISOLATE_DEBUG", () => {
		const previous = process.env.ISOLATE_DEBUG;
		delete process.env.ISOLATE_DEBUG;
		const captured = captureConsole("log");
		try {
			createConsoleLogger("test-logger").debug("quiet");
		} finally {
			captured.restore();
			if (previous === undefined) {
				delete process.env.ISOLATE_DEBUG;
			} else {
				process.env.ISOLATE_DEBUG = previous;
			}
		}
		expect(captured.lines).toHaveLength(0);
	});
});
