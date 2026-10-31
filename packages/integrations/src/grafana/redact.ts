import { redactSecretsUnbounded } from "../github/redact";

/**
 * Grafana-specific redaction.
 *
 * The shared GitHub redactor already removes `Bearer` values, GitHub token
 * families and long opaque credential runs. Grafana adds three shapes that
 * appear in annotations, label values and Loki lines: `glsa_` service-account
 * tokens, JWT-shaped session credentials and `key=value` secrets. Redaction
 * runs before truncation so a secret split at the cut point cannot survive.
 */

/** Bounded error text; provider text never leaves a tool uncapped. */
export const MAX_GRAFANA_MESSAGE_CHARS = 480;

const GRAFANA_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/glsa_[A-Za-z0-9]{16,}/g, "[token-redacted]"],
	[
		/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
		"[token-redacted]",
	],
	[
		/(\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)(["']?)([^\s"',;]+)\2/gi,
		"$1$2[auth-redacted]$2",
	],
	[/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@"],
];

/** Removes every known credential shape plus injected secrets; no cap. */
export function redactGrafanaText(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	let out = redactSecretsUnbounded(text, extraSecrets);
	for (const [pattern, replacement] of GRAFANA_SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** Redacted and capped for a tool result or an error message. */
export function redactGrafanaMessage(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	const out = redactGrafanaText(text, extraSecrets);
	return out.length <= MAX_GRAFANA_MESSAGE_CHARS
		? out
		: `${out.slice(0, MAX_GRAFANA_MESSAGE_CHARS - 1)}…`;
}
