import { redactSecretsUnbounded } from "../github/redact";

/**
 * SigNoz-specific redaction (`docs/connectors/signoz.md` §9).
 *
 * The shared GitHub redactor already removes `Bearer` values, GitHub token
 * families and long opaque credential runs. SigNoz adds shapes that appear in
 * label values, annotations and rule text: `SIGNOZ-API-KEY` header lines,
 * Basic authorization material, JWT-shaped session credentials, `key=value`
 * secrets, credential-bearing URLs, email addresses and IPv4 addresses.
 *
 * Redaction runs before truncation in every caller, so a secret split at the
 * cut point cannot survive. Emails and IPs are high-cardinality identifiers the
 * prompt must never carry; service names and pod names are not redacted (they
 * are the evidence), but `instance`-style IPs are.
 */

/** Bounded error text; provider text never leaves a tool uncapped. */
export const MAX_SIGNOZ_MESSAGE_CHARS = 480;

const SIGNOZ_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bSIGNOZ-API-KEY\s*[:=]\s*[^\s,;]+/gi, "SIGNOZ-API-KEY: [token-redacted]"],
	[
		/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:basic|bearer)\s+[^\s,;]+/gi,
		"$1[auth-redacted]",
	],
	[/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "Basic [auth-redacted]"],
	[
		/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
		"[token-redacted]",
	],
	[
		/(\b(?:password|passwd|secret|token|api[_-]?key|apikey)\s*[:=]\s*)(?!\[(?:auth|token|email|ip)-redacted\])(["']?)([^\s"',;]+)\2/gi,
		"$1$2[auth-redacted]$2",
	],
	[/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@"],
	// Email before IPv4 so a domain that looks numeric is still an email.
	[/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email-redacted]"],
	[/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, "[ip-redacted]"],
];

/** Removes every known credential and identifier shape; no length cap. */
export function redactSignozText(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	let out = redactSecretsUnbounded(text, extraSecrets);
	for (const [pattern, replacement] of SIGNOZ_SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** Redacted and capped for a tool result or an error message. */
export function redactSignozMessage(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	const out = redactSignozText(text, extraSecrets);
	return out.length <= MAX_SIGNOZ_MESSAGE_CHARS
		? out
		: `${out.slice(0, MAX_SIGNOZ_MESSAGE_CHARS - 1)}…`;
}
