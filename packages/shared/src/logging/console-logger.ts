import type { LogFields, Logger } from "./logger";
import { SENSITIVE_KEY_PATTERN } from "./redact";

/**
 * Sensitive key matcher. Implementation-level defence: callers still receive
 * redacted objects, so forgetting to sanitise one field cannot leak a secret.
 */
const SENSITIVE_KEY = SENSITIVE_KEY_PATTERN;

interface Redacted {
	severity: "debug" | "info" | "warn" | "error";
	message: string;
	fields: LogFields;
	/** Sensitive keys are reported as `[redacted]`, never with values. */
	redactedKeys: string[];
	name: string;
}

/**
 * Shallow-redacts a field object: sensitive keys become `[redacted]`.
 * Errors are reduced to name (+ PlatformError code/retryable) — never stacks.
 */
export function redactFields(
	severity: "debug" | "info" | "warn" | "error",
	name: string,
	message: string,
	fields?: LogFields,
): Redacted {
	const out: LogFields = {};
	const redactedKeys: string[] = [];
	if (fields) {
		for (const [key, value] of Object.entries(fields)) {
			if (SENSITIVE_KEY.test(key)) {
				redactedKeys.push(key);
				continue;
			}
			out[key] = value;
		}
	}
	return { severity, name, message, fields: out, redactedKeys };
}

/**
 * Minimal structured console logger. Later replacements (HTTP sinks, trace
 * export) can implement the same `Logger` interface later. `debug` stays
 * silent unless `ISOLATE_DEBUG` is truthy.
 */
export function createConsoleLogger(name: string): Logger {
	const emit = (
		severity: "debug" | "info" | "warn" | "error",
		message: string,
		fields?: LogFields,
	): void => {
		if (severity === "debug" && !process.env.ISOLATE_DEBUG) return;
		const entry = redactFields(severity, name, message, fields);
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			severity: entry.severity,
			logger: entry.name,
			message: entry.message,
			...(Object.keys(entry.fields).length > 0 ? { fields: entry.fields } : {}),
			...(entry.redactedKeys.length > 0
				? { redacted: entry.redactedKeys }
				: {}),
		});
		if (severity === "error" || severity === "warn") {
			console.error(line);
		} else {
			console.log(line);
		}
	};

	const make = (base: LogFields): Logger => {
		const withBase = (fields?: LogFields): LogFields => ({
			...base,
			...(fields ?? {}),
		});
		return {
			debug: (m, f) => emit("debug", m, withBase(f)),
			info: (m, f) => emit("info", m, withBase(f)),
			warn: (m, f) => emit("warn", m, withBase(f)),
			error: (m, f) => emit("error", m, withBase(f)),
			child: (fields) => make({ ...base, ...fields }),
		};
	};

	return make({});
}
