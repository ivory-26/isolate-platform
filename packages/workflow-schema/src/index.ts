import { PlatformError } from "@isolate/shared";

export * from "./compiler";
export * from "./graph";
export * from "./nodes";
export * from "./types";
export * from "./validate";

/**
 * Error construction for the control plane: structured code, no payloads or
 * stack traces, never leaking definition content into the message.
 */
export function workflowNotSupported(detail: string): PlatformError {
	return new PlatformError(
		"VALIDATION_FAILED",
		`workflow define rejected: ${detail}`,
	);
}
