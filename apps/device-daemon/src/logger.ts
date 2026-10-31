/**
 * Structured logging for the daemon.
 *
 * Call sites pass only fixed field names and bounded values: tool name,
 * connector id, outcome, error code and duration. The token, tool params,
 * provider responses and config secret values are never part of a log record.
 */

export type LogValue = string | number | boolean | null;

export type LogFields = Record<string, LogValue>;

export type Logger = {
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
};

function write(
	level: "info" | "warn" | "error",
	message: string,
	fields: LogFields | undefined,
): void {
	const suffix =
		fields === undefined
			? ""
			: ` ${JSON.stringify(
					Object.fromEntries(
						Object.entries(fields).sort(([left], [right]) =>
							left.localeCompare(right),
						),
					),
				)}`;
	const line = `[device-daemon] ${level} ${message}${suffix}`;
	if (level === "error") {
		console.error(line);
		return;
	}
	console.log(line);
}

export function createConsoleLogger(): Logger {
	return {
		info: (message, fields) => write("info", message, fields),
		warn: (message, fields) => write("warn", message, fields),
		error: (message, fields) => write("error", message, fields),
	};
}

/** Test double: records lines without touching stdout. */
export function createMemoryLogger(): Logger & {
	readonly lines: string[];
} {
	const lines: string[] = [];
	const record =
		(level: string) =>
		(message: string, fields?: LogFields): void => {
			lines.push(
				`${level} ${message}${fields === undefined ? "" : ` ${JSON.stringify(fields)}`}`,
			);
		};
	return {
		lines,
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
	};
}
