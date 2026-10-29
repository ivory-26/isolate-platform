import { SandboxError } from "../errors";
import type { AuthorizedCommand } from "../policy/command-policy";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
	SandboxSpec,
} from "./types";

/** Deliberately has no process, filesystem, SDK, or credential dependencies. */
export class NullProvider implements SandboxProvider {
	readonly name = "null";

	async create(_spec: SandboxSpec): Promise<SandboxHandle> {
		throw new SandboxError(
			"PROVIDER_UNAVAILABLE",
			"No isolated sandbox provider is configured",
		);
	}

	async execute(
		_sandbox: SandboxHandle,
		_command: AuthorizedCommand,
		_signal?: AbortSignal,
	): Promise<CommandResult> {
		throw new SandboxError(
			"PROVIDER_UNAVAILABLE",
			"NullProvider never executes commands",
		);
	}

	async destroy(_sandbox: SandboxHandle): Promise<void> {
		// No resources can have been provisioned; cleanup is safely idempotent.
	}
}
