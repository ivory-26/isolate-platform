import { deny, SandboxError } from "./errors";
import {
	type CommandPolicy,
	type CommandRequest,
	commandPolicy,
} from "./policy/command-policy";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
} from "./providers/types";

/** Bounded stdin payload for trusted file writes; never echoed or logged. */
export const MAX_STDIN_BYTES = 1_048_576;

export interface ExecuteCommandOptions {
	/**
	 * Trusted callers that persist a bounded report (validation) need the
	 * provider's already-limited result instead of an exception, so partial
	 * output and the timeout exit code survive. Callers MUST clip the returned
	 * streams to the policy budget before storing or echoing them.
	 */
	readonly surfaceLimits?: boolean;
}

/** Result checks detect broken adapters; they cannot replace isolation or stream caps. */
export async function executeCommand(
	provider: SandboxProvider,
	sandbox: SandboxHandle,
	policy: CommandPolicy,
	request: CommandRequest,
	signal?: AbortSignal,
	stdinText?: string,
	options?: ExecuteCommandOptions,
): Promise<CommandResult> {
	if (sandbox.workspaceRoot !== policy.workspaceRoot)
		deny("Policy does not belong to this sandbox");
	if (signal?.aborted)
		throw new SandboxError("CANCELLED", "Command was cancelled");
	if (
		stdinText !== undefined &&
		(typeof stdinText !== "string" ||
			Buffer.byteLength(stdinText, "utf8") > MAX_STDIN_BYTES)
	)
		deny("Stdin payload exceeds its budget");
	const command = commandPolicy(policy, request);
	const result = await provider.execute(sandbox, command, signal, stdinText);
	if (signal?.aborted)
		throw new SandboxError("CANCELLED", "Command was cancelled");
	if (
		typeof result.stdout !== "string" ||
		typeof result.stderr !== "string" ||
		!Number.isInteger(result.exitCode) ||
		!Number.isFinite(result.durationMs) ||
		result.durationMs < 0 ||
		typeof result.timedOut !== "boolean" ||
		typeof result.outputLimitExceeded !== "boolean"
	) {
		throw new SandboxError(
			"PROVIDER_PROTOCOL",
			"Invalid sandbox execution result",
		);
	}
	if (!options?.surfaceLimits) {
		if (result.timedOut || result.durationMs > command.timeoutMs)
			throw new SandboxError("TIMEOUT", "Command exceeded its time budget");
		if (
			result.outputLimitExceeded ||
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >
				command.maxOutputBytes
		) {
			throw new SandboxError(
				"OUTPUT_LIMIT",
				"Command exceeded its output budget",
			);
		}
	}
	return Object.freeze({ ...result });
}
