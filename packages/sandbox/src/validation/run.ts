import type { ValidationReport } from "../../../shared/src/types/review";
import { deny, SandboxError } from "../errors";
import { executeCommand } from "../execute";
import {
	type CommandPolicy,
	type CommandRequest,
	commandPolicy,
	type EgressPolicy,
	VALIDATION_COMMAND_ALLOWLIST,
} from "../policy/command-policy";
import { validateSandboxPath } from "../policy/paths";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
} from "../providers/types";

/**
 * Wave-8 validation runner (backend only).
 *
 * One operator-configured validation command is tokenized WITHOUT a shell,
 * authorized against an explicit test-entry allowlist, executed over the
 * existing argv-only sandbox path with network denied, and mapped to the
 * shared, strictly bounded `ValidationReport`.
 *
 * Refusals (empty/oversize command, broken quoting, shell metacharacters,
 * unknown executable or argv shape, timeout outside 1000–900000 ms, path
 * outside the sandbox) throw `POLICY_DENIED` before the provider is called.
 * Only failures that happen once execution was authorized are turned into a
 * `failed` report; those carry `exitCode: -1` because the command never
 * started. `CANCELLED` is re-thrown so a cancelled task does not record a
 * bogus validation failure.
 *
 * `skipped` is never produced here: an empty command cannot be represented in
 * `validationReportSchema` (it requires a non-empty `command` and `argv`), so
 * "no validation configured" stays a worker-level decision that never calls
 * this runner.
 */

/** Inline capture cap for stdout+stderr; also the policy output budget. */
export const VALIDATION_OUTPUT_CAP_BYTES = 65_536;
export const VALIDATION_MIN_TIMEOUT_MS = 1_000;
export const VALIDATION_MAX_TIMEOUT_MS = 900_000;
export const MAX_VALIDATION_COMMAND_LENGTH = 512;
export const MAX_VALIDATION_TOKENS = 32;
export const MAX_VALIDATION_TOKEN_LENGTH = 256;

const DENY_EGRESS: EgressPolicy = Object.freeze({ mode: "deny" });
const SHELL_METACHARACTERS = /[;|&><$`()]/;
const QUOTES = new Set(["'", '"']);

/** Tabs, CR/LF and every other control character never belong in a command. */
function containsControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

export interface ValidationRunnerDeps {
	readonly provider: SandboxProvider;
	readonly sandbox: SandboxHandle;
	/** Absolute repository path inside the sandbox; becomes the command cwd. */
	readonly repoPath: string;
	/** Injectable clock (ms epoch); defaults to `Date.now`. */
	readonly now?: () => number;
}

export interface ValidationCommandInput {
	readonly command: string;
	readonly timeoutMs: number;
}

export interface ValidationOutcome {
	readonly report: ValidationReport;
	/** Captured stdout followed by stderr, never above the 64 KiB cap. */
	readonly output: string;
}

/**
 * Whitespace tokenization with single/double quote grouping and no escape
 * processing. Quotes are removed; nothing is interpolated or expanded.
 */
export function tokenizeValidationCommand(command: string): string[] {
	if (typeof command !== "string") deny("Validation command must be text");
	if (command.length === 0 || command.length > MAX_VALIDATION_COMMAND_LENGTH)
		deny("Validation command must be 1 to 512 characters");
	if (containsControlCharacter(command))
		deny("Validation command must not contain control characters");
	if (SHELL_METACHARACTERS.test(command))
		deny("Validation command must not contain shell metacharacters");

	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: string | null = null;
	for (const char of command) {
		if (quote !== null) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (QUOTES.has(char)) {
			quote = char;
			started = true;
		} else if (char === " ") {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
		} else {
			current += char;
			started = true;
		}
	}
	if (quote !== null) deny("Validation command has an unterminated quote");
	if (started) tokens.push(current);
	if (tokens.length === 0) deny("Validation command is empty");
	if (tokens.length > MAX_VALIDATION_TOKENS)
		deny("Validation command has more than 32 tokens");
	for (const token of tokens) {
		if (token.length === 0)
			deny("Validation command must not contain empty arguments");
		if (token.length > MAX_VALIDATION_TOKEN_LENGTH)
			deny("Validation command has an argument longer than 256 characters");
	}
	return tokens;
}

function validateValidationTimeout(value: number): number {
	if (
		!Number.isSafeInteger(value) ||
		value < VALIDATION_MIN_TIMEOUT_MS ||
		value > VALIDATION_MAX_TIMEOUT_MS
	)
		deny("Validation timeout must be an integer between 1000 and 900000 ms");
	return value;
}

/** Clock-derived duration, clamped to the report's 0–900000 ms contract. */
function elapsedMs(startedAt: number, clock: () => number): number {
	const elapsed = clock() - startedAt;
	if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
	return Math.min(VALIDATION_MAX_TIMEOUT_MS, Math.round(elapsed));
}

/** Longest code-point prefix whose UTF-8 encoding fits the byte budget. */
function utf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

interface CapturedOutput {
	readonly output: string;
	readonly bytes: number;
	readonly clipped: boolean;
}

/**
 * Combined stdout+stderr prefix under the 64 KiB cap. Providers already clip
 * (and flag it); the second clip is defense in depth for a misbehaving adapter.
 * `outputBytes` is the retained byte count: no provider exposes how much output
 * existed before its own truncation, and the shared contract forbids invented
 * totals.
 */
function captureOutput(result: CommandResult): CapturedOutput {
	const stdout = utf8Prefix(result.stdout, VALIDATION_OUTPUT_CAP_BYTES);
	const remaining =
		VALIDATION_OUTPUT_CAP_BYTES - Buffer.byteLength(stdout, "utf8");
	const stderr = utf8Prefix(result.stderr, remaining);
	const output = stdout + stderr;
	const bytes = Buffer.byteLength(output, "utf8");
	const produced =
		Buffer.byteLength(result.stdout, "utf8") +
		Buffer.byteLength(result.stderr, "utf8");
	return { output, bytes, clipped: produced > bytes };
}

function failureOutcome(
	command: string,
	argv: readonly string[],
	duration: number,
): ValidationOutcome {
	return {
		report: {
			command,
			argv: [...argv],
			status: "failed",
			exitCode: -1,
			durationMs: duration,
			outputBytes: 0,
			truncated: false,
		},
		output: "",
	};
}

export async function runValidationCommand(
	deps: ValidationRunnerDeps,
	input: ValidationCommandInput,
): Promise<ValidationOutcome> {
	if (!deps || typeof deps !== "object")
		deny("Validation requires sandbox dependencies");
	if (!deps.provider || typeof deps.provider.execute !== "function")
		deny("Validation requires an isolated sandbox provider");
	if (
		!deps.sandbox ||
		typeof deps.sandbox.id !== "string" ||
		typeof deps.sandbox.workspaceRoot !== "string"
	)
		deny("Validation requires a valid sandbox handle");
	if (!input || typeof input !== "object")
		deny("Validation requires a command and timeout");

	const clock = deps.now ?? Date.now;
	if (typeof clock !== "function") deny("Validation clock must be a function");

	const repoPath = validateSandboxPath(
		deps.sandbox.workspaceRoot,
		deps.repoPath,
	);
	const timeoutMs = validateValidationTimeout(input.timeoutMs);
	const command = input.command;
	const argv = tokenizeValidationCommand(command);

	const policy: CommandPolicy = {
		workspaceRoot: deps.sandbox.workspaceRoot,
		allowlist: VALIDATION_COMMAND_ALLOWLIST,
		maxTimeoutMs: timeoutMs,
		maxOutputBytes: VALIDATION_OUTPUT_CAP_BYTES,
		egress: DENY_EGRESS,
	};
	const request: CommandRequest = {
		executable: argv[0],
		args: argv.slice(1),
		cwd: repoPath,
		timeoutMs,
		maxOutputBytes: VALIDATION_OUTPUT_CAP_BYTES,
		egress: DENY_EGRESS,
	};
	// Authorize (and refuse) before the provider or the clock is involved.
	commandPolicy(policy, request);

	const startedAt = clock();
	let result: CommandResult;
	try {
		result = await executeCommand(
			deps.provider,
			deps.sandbox,
			policy,
			request,
			undefined,
			undefined,
			{ surfaceLimits: true },
		);
	} catch (error) {
		if (
			error instanceof SandboxError &&
			(error.code === "POLICY_DENIED" || error.code === "CANCELLED")
		)
			throw error;
		// Provider/protocol failures after authorization: the command never ran.
		return failureOutcome(command, argv, elapsedMs(startedAt, clock));
	}

	const durationMs = elapsedMs(startedAt, clock);
	if (
		!Number.isInteger(result.exitCode) ||
		result.exitCode < 0 ||
		result.exitCode > 255
	) {
		// A broken adapter must not leak an unrepresentable exit code.
		return failureOutcome(command, argv, durationMs);
	}

	const captured = captureOutput(result);
	const timedOut = result.timedOut || result.durationMs > timeoutMs;
	const exitCode = timedOut ? 124 : result.exitCode;
	const report: ValidationReport = {
		command,
		argv: [...argv],
		status: !timedOut && exitCode === 0 ? "passed" : "failed",
		exitCode,
		durationMs,
		outputBytes: captured.bytes,
		truncated: result.outputLimitExceeded || captured.clipped,
	};
	return { report, output: captured.output };
}
