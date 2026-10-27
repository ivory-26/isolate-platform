/**
 * Credential redaction (§11): tokens must never appear in thrown messages,
 * Result messages, or audit details. These helpers are the single choke point
 * any provider text flows through before leaving `github/`.
 */

/** Sanitized messages are capped so provider payloads cannot flood logs. */
export const MAX_SANITIZED_MESSAGE_LENGTH = 480;

/**
 * Built-in token shapes (order matters: literal `Bearer` prefix first, then
 * GitHub token families, then long opaque runs). Each maps to a fixed marker.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/(?:bearer|token|authorization[:=]?)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
		"[auth-redacted]",
	],
	[/github_pat_[A-Za-z0-9_]{8,}/g, "[token-redacted]"],
	[/gh[a-z]_[A-Za-z0-9]{8,}/g, "[token-redacted]"],
	[/[A-Za-z0-9+/_-]{43,}/g, "[redacted]"],
];

const OVERRIDDEN_SECRET_MARKER = "[token-redacted]";

/**
 * Removes every known credential shape and every explicitly injected secret
 * from `text`, then caps the result. Secrets shorter than 8 characters are
 * ignored (not creditable credentials).
 */
export function redactSecrets(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	let out = text;
	for (const secret of extraSecrets) {
		if (typeof secret === "string" && secret.length >= 8) {
			out = out.split(secret).join(OVERRIDDEN_SECRET_MARKER);
		}
	}
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	if (out.length > MAX_SANITIZED_MESSAGE_LENGTH) {
		return `${out.slice(0, MAX_SANITIZED_MESSAGE_LENGTH)}…`;
	}
	return out;
}
