import { redactSecretsUnbounded } from "../github/redact";

/**
 * Datadog-specific redaction (`docs/connectors/datadog.md` §8–§9).
 *
 * The shared GitHub redactor removes `Bearer` values, GitHub token families
 * and long opaque credential runs. Datadog adds shapes that appear in incident
 * impact text, monitor tags and log attributes: 32/40-hex API/application
 * keys, `DD-API-KEY`/`DD-APPLICATION-KEY` header pairs, JWTs, `key=value`
 * secrets, URL userinfo, e-mail addresses and IPv4 literals. Redaction runs
 * **before** truncation, so a secret split at the cut point cannot survive.
 */

/** Bounded error text; provider text never leaves a tool uncapped. */
export const MAX_DATADOG_MESSAGE_CHARS = 480;

const DATADOG_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/(\bdd-(?:api|application)-key\s*[:=]\s*)(["']?)([^\s"',;]+)\2/gi,
		"$1$2[key-redacted]$2",
	],
	// Datadog API keys are 32 hex characters, application keys 40.
	[/\b[0-9a-f]{40}\b/gi, "[key-redacted]"],
	[/\b[0-9a-f]{32}\b/gi, "[key-redacted]"],
	[
		/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
		"[token-redacted]",
	],
	[
		/(\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)(["']?)([^\s"',;]+)\2/gi,
		"$1$2[auth-redacted]$2",
	],
	[/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@"],
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email-redacted]"],
	[/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-redacted]"],
];

/** Removes every known credential/PII shape plus injected secrets; no cap. */
export function redactDatadogText(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	let out = redactSecretsUnbounded(text, extraSecrets);
	for (const [pattern, replacement] of DATADOG_SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** Redacted and capped for a tool result or an error message. */
export function redactDatadogMessage(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	const out = redactDatadogText(text, extraSecrets);
	return out.length <= MAX_DATADOG_MESSAGE_CHARS
		? out
		: `${out.slice(0, MAX_DATADOG_MESSAGE_CHARS - 1)}…`;
}
