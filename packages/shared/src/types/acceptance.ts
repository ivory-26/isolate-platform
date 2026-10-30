import { z } from "zod";

/**
 * Machine-checkable acceptance criteria (wave 9).
 *
 * Completion must be proven by the task's environment, not by a model saying
 * "done" or by a turn budget running out. Each check is bounded and either
 * reads the task workspace (paths/content) or runs one allowlisted command
 * through the trusted sandbox policy — never a shell string.
 */

const WORKSPACE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,400}$/;

export const acceptanceCheckSchema = z.discriminatedUnion("kind", [
	z
		.strictObject({
			kind: z.literal("path_exists"),
			path: z
				.string()
				.regex(WORKSPACE_PATH, "relative workspace path required"),
		})
		.readonly(),
	z
		.strictObject({
			kind: z.literal("content_matches"),
			path: z
				.string()
				.regex(WORKSPACE_PATH, "relative workspace path required"),
			/** Bounded regular expression evaluated against the file text. */
			pattern: z.string().min(1).max(200),
		})
		.readonly(),
	z
		.strictObject({
			kind: z.literal("command_exit_zero"),
			/** Validated again against the sandbox validation allowlist. */
			command: z.string().min(1).max(512),
		})
		.readonly(),
]);

export type AcceptanceCheck = z.infer<typeof acceptanceCheckSchema>;

export const ACCEPTANCE_CHECK_KINDS = [
	"path_exists",
	"content_matches",
	"command_exit_zero",
] as const;

export const acceptanceCheckResultSchema = z
	.object({
		kind: z.enum(ACCEPTANCE_CHECK_KINDS),
		/** Path or command, bounded; never file content. */
		target: z.string().min(1).max(512),
		passed: z.boolean(),
		/** Bounded, redacted-in-practice reason; never echoes file content. */
		detail: z.string().max(200).optional(),
	})
	.strict();

export type AcceptanceCheckResult = z.infer<typeof acceptanceCheckResultSchema>;

export const acceptanceReportSchema = z
	.object({
		passed: z.boolean(),
		matched: z.number().int().min(0).max(64),
		total: z.number().int().min(0).max(64),
		checks: z.array(acceptanceCheckResultSchema).max(64),
		durationMs: z.number().int().min(0).max(900_000),
	})
	.strict()
	.refine((report) => report.matched <= report.total, {
		message: "matched cannot exceed total",
		path: ["matched"],
	});

export type AcceptanceReport = z.infer<typeof acceptanceReportSchema>;
