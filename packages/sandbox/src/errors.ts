export type SandboxErrorCode =
	| "POLICY_DENIED"
	| "PROVIDER_UNAVAILABLE"
	| "PROVIDER_PROTOCOL"
	| "TIMEOUT"
	| "OUTPUT_LIMIT"
	| "CANCELLED"
	| "GIT_FAILED";

/** Messages never include repository output, command arguments, or credentials. */
export class SandboxError extends Error {
	constructor(
		readonly code: SandboxErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SandboxError";
	}
}

export function deny(message: string): never {
	throw new SandboxError("POLICY_DENIED", message);
}
