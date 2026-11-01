import {
	DEFAULT_VALIDATION_TIMEOUT_MS,
	type RepositoryProvider,
	type ValidatedRepositoryRegistration,
} from "./contracts";

/**
 * Pure normalization applied before the persistence layer sees a registration.
 * The database repository re-validates every bound; this only decides which
 * scalar values to send so the client and server cannot drift.
 */
export function prepareRepositoryCreate(
	input: ValidatedRepositoryRegistration,
): {
	provider: RepositoryProvider;
	externalFullName: string;
	defaultBranch: string;
} {
	return {
		provider: input.provider,
		externalFullName: input.externalFullName.trim(),
		defaultBranch: input.defaultBranch.trim(),
	};
}

/**
 * Resolves the optional validation policy. Returns `null` when the caller left
 * the policy at its defaults, so registration performs exactly one insert.
 */
export function prepareRepositoryPolicy(
	input: ValidatedRepositoryRegistration,
): {
	validationCommand: string | null;
	validationTimeoutMs: number;
} | null {
	const command = input.validationCommand?.trim() ?? "";
	const validationTimeoutMs =
		input.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
	if (
		command.length === 0 &&
		validationTimeoutMs === DEFAULT_VALIDATION_TIMEOUT_MS
	) {
		return null;
	}
	return {
		validationCommand: command.length === 0 ? null : command,
		validationTimeoutMs,
	};
}
