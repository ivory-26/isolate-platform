/**
 * Logger contract shared by web, worker, and agent runtimes.
 *
 * Rules (ARCHITECTURE.md §11):
 * - structured fields, never raw template interpolation of untrusted text
 * - sensitive field names must be dropped by the implementation, not by callers
 * - no connection strings, tokens, provider payloads, or stack traces in values
 */
export type LogFields = Record<string, unknown>;

export type LogSeverity = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
	/** Returns a logger that attaches `fields` to every subsequent call. */
	child(fields: LogFields): Logger;
}
