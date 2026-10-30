import type { SandboxToolBackend } from "@isolate/mastra";
import {
	runValidationCommand,
	SandboxError,
	type SandboxHandle,
	type SandboxProvider,
} from "@isolate/sandbox";
import type {
	AcceptanceCheck,
	AcceptanceCheckResult,
	AcceptanceReport,
} from "@isolate/shared";
import { PlatformError } from "@isolate/shared";

/**
 * Machine-checkable acceptance verifier (wave 9).
 *
 * Completion is proven by the task's environment: each declared check either
 * reads a bounded file through the same sandbox-bound `SandboxToolBackend` the
 * agent used, or runs one allowlisted command through `runValidationCommand`
 * (argv-only, egress denied, output capped). The report is bounded and never
 * carries file content: `detail` is a fixed, short reason and `target` is the
 * check's path or command.
 *
 * Refusals:
 * - a malformed check is reported as a failed check, never silently skipped;
 * - `content_matches` is a bounded LITERAL substring test (`String#includes`)
 *   over the capped read, never a compiled regular expression: an
 *   operator-authored pattern cannot trigger catastrophic backtracking, and
 *   every character (including `+`, `*`, `(`, `.`, `^`) matches itself. The
 *   shared schema still calls the field `pattern` and bounds it at 200
 *   characters; that name is retained for wire compatibility only.
 * - a refused command (not on the validation allowlist) fails the check and
 *   the provider is never called;
 * - cancellation (`CANCELLED` / lease lost) is re-thrown so a lost lease does
 *   not persist a bogus acceptance failure.
 */

/** Inline read bound for acceptance file checks (and the report artifact cap). */
export const MAX_ACCEPTANCE_READ_BYTES = 65_536;
/** Hard bound on evaluated checks (the DB column allows at most 32). */
export const MAX_ACCEPTANCE_CHECKS = 32;
/** Longest `detail` the shared result schema accepts. */
const MAX_DETAIL_CHARS = 200;
/** Default per-command bound when the repository has no timeout configured. */
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 900_000;
/** Same relative, traversal-free shape as the shared acceptance path schema. */
const WORKSPACE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,400}$/;

export type AcceptanceSinks = {
	/** Emitted before the first check; `total` is the evaluated count. */
	started?(input: { readonly total: number }): Promise<void> | void;
	/** Emitted with the bounded report after verification. */
	finished?(report: AcceptanceReport): Promise<void> | void;
	/** Persists the bounded report artifact (kind `report`). */
	artifact?(input: {
		readonly content: string;
		readonly sha256: string;
	}): Promise<void> | void;
};

export type AcceptanceRunnerDeps = {
	readonly provider: SandboxProvider;
	readonly sandbox: SandboxHandle;
	/** Absolute checkout path inside the sandbox. */
	readonly repoPath: string;
	/**
	 * Sandbox-bound read surface. `null` (no backend was provisioned) makes
	 * file checks fail closed instead of guessing.
	 */
	readonly backend: SandboxToolBackend | null;
	readonly checks: readonly AcceptanceCheck[];
	/** Task/repository timeout used for `command_exit_zero` checks. */
	readonly timeoutMs?: number;
	readonly now?: () => number;
	readonly signal?: AbortSignal;
	readonly sinks?: AcceptanceSinks;
};

function boundedDetail(value: string): string {
	const text = value.replace(/[\r\n\t]+/g, " ").trim();
	return text.length > MAX_DETAIL_CHARS
		? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`
		: text;
}

function boundedTarget(value: string): string {
	return value.length > 512 ? value.slice(0, 512) : value;
}

function isCancellation(error: unknown): boolean {
	return (
		(error instanceof SandboxError && error.code === "CANCELLED") ||
		(error instanceof PlatformError && error.code === "LEASE_LOST")
	);
}

/** A lost lease aborts verification with the sandbox cancellation code. */
function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) {
		throw new SandboxError("CANCELLED", "cancelled");
	}
}

function validWorkspacePath(path: string): boolean {
	return WORKSPACE_PATH.test(path);
}

/** One failed result; `target` and `detail` are bounded and payload-free. */
function failure(
	kind: AcceptanceCheckResult["kind"],
	target: string,
	detail: string,
): AcceptanceCheckResult {
	return {
		kind,
		target: boundedTarget(target),
		passed: false,
		detail: boundedDetail(detail),
	};
}

function success(
	kind: AcceptanceCheckResult["kind"],
	target: string,
): AcceptanceCheckResult {
	return { kind, target: boundedTarget(target), passed: true };
}

function clampTimeout(value: number | undefined): number {
	const requested =
		value === undefined || !Number.isFinite(value)
			? DEFAULT_ACCEPTANCE_TIMEOUT_MS
			: Math.floor(value);
	return Math.max(MIN_TIMEOUT_MS, Math.min(requested, MAX_TIMEOUT_MS));
}

function boundedDuration(startedAt: number, clock: () => number): number {
	const elapsed = clock() - startedAt;
	if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
	return Math.min(MAX_TIMEOUT_MS, Math.round(elapsed));
}

/** Reads one file through the backend; never returns or logs its content. */
async function readBounded(
	backend: SandboxToolBackend,
	path: string,
): Promise<
	{ readonly ok: true } | { readonly ok: false; readonly detail: string }
> {
	try {
		await backend.readFile(path, { maxBytes: MAX_ACCEPTANCE_READ_BYTES });
		return { ok: true };
	} catch (error) {
		if (isCancellation(error)) {
			throw new SandboxError("CANCELLED", "cancelled");
		}
		if (error instanceof PlatformError && error.code === "NOT_FOUND") {
			return { ok: false, detail: "file not found" };
		}
		return { ok: false, detail: "file unreadable" };
	}
}

async function evaluateCheck(
	deps: AcceptanceRunnerDeps,
	check: AcceptanceCheck,
	timeoutMs: number,
): Promise<AcceptanceCheckResult> {
	switch (check.kind) {
		case "path_exists": {
			if (!validWorkspacePath(check.path)) {
				return failure("path_exists", check.path, "invalid workspace path");
			}
			const backend = deps.backend;
			if (backend === null) {
				return failure("path_exists", check.path, "read surface unavailable");
			}
			assertNotAborted(deps.signal);
			const read = await readBounded(backend, check.path);
			return read.ok
				? success("path_exists", check.path)
				: failure("path_exists", check.path, read.detail);
		}
		case "content_matches": {
			if (!validWorkspacePath(check.path)) {
				return failure("content_matches", check.path, "invalid workspace path");
			}
			const backend = deps.backend;
			if (backend === null) {
				return failure(
					"content_matches",
					check.path,
					"read surface unavailable",
				);
			}
			assertNotAborted(deps.signal);
			let content: string;
			try {
				const result = await backend.readFile(check.path, {
					maxBytes: MAX_ACCEPTANCE_READ_BYTES,
				});
				content = result.content;
			} catch (error) {
				if (isCancellation(error)) {
					throw new SandboxError("CANCELLED", "cancelled");
				}
				return failure(
					"content_matches",
					check.path,
					error instanceof PlatformError && error.code === "NOT_FOUND"
						? "file not found"
						: "file unreadable",
				);
			}
			// Bounded literal substring match: no RegExp is constructed, so no
			// operator-authored pattern can backtrack. Content is tested and
			// discarded: only booleans leave this scope.
			return content.includes(check.pattern)
				? success("content_matches", check.path)
				: failure("content_matches", check.path, "pattern not matched");
		}
		case "command_exit_zero": {
			assertNotAborted(deps.signal);
			try {
				const outcome = await runValidationCommand(
					{
						provider: deps.provider,
						sandbox: deps.sandbox,
						repoPath: deps.repoPath,
						...(deps.now === undefined ? {} : { now: deps.now }),
					},
					{ command: check.command, timeoutMs },
				);
				return outcome.report.status === "passed"
					? success("command_exit_zero", check.command)
					: failure(
							"command_exit_zero",
							check.command,
							outcome.report.exitCode === 124
								? "command timed out"
								: `command exited ${outcome.report.exitCode}`,
						);
			} catch (error) {
				if (error instanceof SandboxError && error.code === "CANCELLED") {
					throw error;
				}
				if (error instanceof SandboxError && error.code === "POLICY_DENIED") {
					return failure(
						"command_exit_zero",
						check.command,
						"command refused by policy",
					);
				}
				throw error;
			}
		}
	}
}

function buildReport(
	results: readonly AcceptanceCheckResult[],
	durationMs: number,
): AcceptanceReport {
	const matched = results.filter((result) => result.passed).length;
	return {
		passed: results.length > 0 && matched === results.length,
		matched,
		total: results.length,
		checks: [...results],
		durationMs: Math.max(0, Math.min(MAX_TIMEOUT_MS, Math.round(durationMs))),
	};
}

function reportArtifact(report: AcceptanceReport): {
	readonly content: string;
	readonly sha256: string;
} {
	const content = JSON.stringify(report);
	return {
		content,
		sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
	};
}

/**
 * Fail-closed report for configuration that does not satisfy
 * `acceptanceCheckSchema` (for example a malformed persisted row). No check is
 * run, `total` is bounded, and the caller still persists the report artifact.
 */
export function invalidAcceptanceReport(total: number): AcceptanceReport {
	const bounded = Number.isFinite(total)
		? Math.max(0, Math.min(MAX_ACCEPTANCE_CHECKS, Math.floor(total)))
		: 0;
	return {
		passed: false,
		matched: 0,
		total: bounded,
		checks: [],
		durationMs: 0,
	};
}

/** The bounded `report` artifact content and digest for any report. */
export function acceptanceReportArtifact(report: AcceptanceReport): {
	readonly content: string;
	readonly sha256: string;
} {
	return reportArtifact(report);
}

/**
 * Runs every check in order and returns the shared, bounded report. Sinks are
 * awaited in the documented order: `started` → checks → `finished` →
 * `artifact`.
 */
export async function runAcceptanceChecks(
	deps: AcceptanceRunnerDeps,
): Promise<AcceptanceReport> {
	const clock = deps.now ?? Date.now;
	const startedAt = clock();
	const timeoutMs = clampTimeout(deps.timeoutMs);
	const checks = deps.checks.slice(0, MAX_ACCEPTANCE_CHECKS);

	await deps.sinks?.started?.({ total: checks.length });

	const results: AcceptanceCheckResult[] = [];
	for (const check of checks) {
		assertNotAborted(deps.signal);
		results.push(await evaluateCheck(deps, check, timeoutMs));
	}

	const report = buildReport(results, boundedDuration(startedAt, clock));
	await deps.sinks?.finished?.(report);
	const artifact = reportArtifact(report);
	await deps.sinks?.artifact?.(artifact);
	return report;
}
