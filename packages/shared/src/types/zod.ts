import type { z } from "zod";
import { PlatformError } from "./errors";
import { err, ok, type Result } from "./result";

/**
 * Safe error-text builder for Zod failures. Only field paths and issue codes
 * are emitted — never the offending input values — so untrusted payload
 * content cannot end up in error messages or logs.
 */
export function zodIssueSummary(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.join(".");
			return `${path.length > 0 ? path : "(root)"}.${issue.code}`;
		})
		.join("; ");
}

/** Parses untrusted input into a schema-validated, `Result`-wrapped value. */
export function parseWith<T>(
	schema: z.ZodType<T>,
	input: unknown,
): Result<T, PlatformError> {
	const parsed = schema.safeParse(input);
	if (parsed.success) {
		return ok(parsed.data);
	}
	return err(
		new PlatformError("VALIDATION_FAILED", zodIssueSummary(parsed.error)),
	);
}
