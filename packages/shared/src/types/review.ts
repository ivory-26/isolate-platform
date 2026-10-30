import { z } from "zod";

/**
 * Cross-package review contracts (wave 8).
 *
 * A validation run and a pull-request record are produced in the execution
 * plane and consumed by the worker, the control plane and the acceptance
 * scripts, so their shape lives here rather than in one package. Neither type
 * carries credentials, raw output or unbounded text: log content is stored as a
 * bounded artifact, never inline in these records.
 */

export const VALIDATION_STATUSES = ["passed", "failed", "skipped"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/** Git object id; 40 hex for sha1 repositories, up to 64 for sha256 ones. */
export const GIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/;

export const validationReportSchema = z
	.object({
		/** The configured command exactly as the operator wrote it (bounded). */
		command: z.string().min(1).max(512),
		/** Tokenized argv actually executed; never a shell string. */
		argv: z.array(z.string().min(1).max(256)).min(1).max(32),
		status: z.enum(VALIDATION_STATUSES),
		/** Process exit code; -1 means the command never started. */
		exitCode: z.number().int().min(-1).max(255),
		durationMs: z.number().int().min(0).max(900_000),
		/** Captured stdout+stderr bytes before truncation. */
		outputBytes: z.number().int().min(0),
		truncated: z.boolean(),
	})
	.strict();

export type ValidationReport = z.infer<typeof validationReportSchema>;

export const pullRequestRecordSchema = z
	.object({
		number: z.number().int().positive(),
		url: z
			.string()
			.min(1)
			.max(512)
			.regex(/^https:\/\/[^\s]+$/, "https URL required"),
		headBranch: z.string().min(1).max(255),
		baseBranch: z.string().min(1).max(255),
		headSha: z.string().regex(GIT_SHA_PATTERN),
	})
	.strict();

export type PullRequestRecord = z.infer<typeof pullRequestRecordSchema>;
