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

/** Result checks detect broken adapters; they cannot replace isolation or stream caps. */
export async function executeCommand(
	provider: SandboxProvider,
	sandbox: SandboxHandle,
	policy: CommandPolicy,
	request: CommandRequest,
	signal?: AbortSignal,
): Promise<CommandResult> {
	if (sandbox.workspaceRoot !== policy.workspaceRoot)
		deny("Policy does not belong to this sandbox");
	if (signal?.aborted)
		throw new SandboxError("CANCELLED", "Command was cancelled");
	const command = commandPolicy(policy, request);
	const result = await provider.execute(sandbox, command, signal);
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
	return Object.freeze({ ...result });
}
