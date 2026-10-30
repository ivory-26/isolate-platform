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
		// Keyword-led authorization material: the imperative keyword is kept for
		// readability, the credential run that follows it is scrubbed. Requires
		// whitespace before the credential so already-redacted markers such as
		// "[token-redacted]" are never re-matched against themselves.
		/(\b(?:bearer|token))\s*[:=]?\s+[A-Za-z0-9._~+/=-]{6,}/gi,
		"$1 [auth-redacted]",
	],
	[/github_pat_[A-Za-z0-9_]{8,}/g, "[token-redacted]"],
	[/gh[a-z]_[A-Za-z0-9]{8,}/g, "[token-redacted]"],
	[
		// Long opaque runs that look credential-shaped. The lookaheads require
		// mixed character classes (upper plus lower) so plain repeated filler
		// text is not swallowed wholesale and still gets length-capped below.
		/(?=[A-Za-z0-9+/_-]{43,})(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9+/_-]{43,}/g,
		"[redacted]",
	],
];

const OVERRIDDEN_SECRET_MARKER = "[token-redacted]";

/** Replaces every known credential shape and injected secret; no length cap. */
function redactAll(text: string, extraSecrets: readonly string[]): string {
	let out = text;
	for (const secret of extraSecrets) {
		if (typeof secret === "string" && secret.length >= 8) {
			out = out.split(secret).join(OVERRIDDEN_SECRET_MARKER);
		}
	}
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/**
 * Removes every known credential shape and every explicitly injected secret
 * from `text`, then caps the result. Secrets shorter than 8 characters are
 * ignored (not creditable credentials).
 */
export function redactSecrets(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	const out = redactAll(text, extraSecrets);
	if (out.length > MAX_SANITIZED_MESSAGE_LENGTH) {
		return `${out.slice(0, MAX_SANITIZED_MESSAGE_LENGTH)}…`;
	}
	return out;
}

/**
 * Context-excerpt variant (§4.6): redaction runs **before** truncation and the
 * 480-character message cap does not apply — the excerpt cap belongs to the
 * bundle assembler, after redaction. A secret split across the cut point is
 * already scrubbed here, so a fragment cannot survive.
 */
export function redactSecretsUnbounded(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	return redactAll(text, extraSecrets);
}
