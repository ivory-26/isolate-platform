import type { PlatformError } from "./errors";

/** Discriminated result type; failures carry only typed, bounded errors. */
export type Result<T, E = PlatformError> =
	| { ok: true; value: T }
	| { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function isOk<T, E>(
	result: Result<T, E>,
): result is { ok: true; value: T } {
	return result.ok;
}

export function isErr<T, E>(
	result: Result<T, E>,
): result is { ok: false; error: E } {
	return !result.ok;
}
