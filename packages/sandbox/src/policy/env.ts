import { deny } from "../errors";

/** Create-time environment is small, trusted tooling configuration (for Git). */
export const MAX_ENV_KEYS = 16;
export const MAX_ENV_VALUE_LENGTH = 4096;
export const MAX_ENV_NAME_LENGTH = 64;

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Validates `SandboxSpec.env` before provisioning.
 *
 * The environment carries the short-lived Git credential
 * (`GIT_CONFIG_COUNT/GIT_CONFIG_KEY_0/GIT_CONFIG_VALUE_0`). It is never
 * model-visible and never logged, so the validator only checks shape and
 * bounds: 16 keys, `[A-Z][A-Z0-9_]{0,63}` names, values up to 4096 characters,
 * no control characters.
 *
 * Returns a frozen copy so callers cannot mutate a validated environment after
 * the check, or `undefined` when no environment was provided.
 */
export function validateSandboxEnv(
	value: unknown,
): Readonly<Record<string, string>> | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value))
		deny("Sandbox environment must be a plain object");
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_ENV_KEYS)
		deny("Sandbox environment has too many keys");
	const env: Record<string, string> = {};
	for (const [name, entry] of entries) {
		if (
			typeof name !== "string" ||
			name.length > MAX_ENV_NAME_LENGTH ||
			!ENV_NAME.test(name)
		)
			deny("Sandbox environment variable name is not allowed");
		if (
			typeof entry !== "string" ||
			entry.length > MAX_ENV_VALUE_LENGTH ||
			Array.from(entry).some((char) => {
				const code = char.charCodeAt(0);
				return code < 32 || code === 127;
			})
		)
			deny("Sandbox environment variable value is not allowed");
		env[name] = entry;
	}
	return Object.freeze(env);
}
