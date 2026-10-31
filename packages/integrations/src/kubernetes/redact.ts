import { redactSecretsUnbounded } from "../github/redact";

/**
 * Kubernetes text redaction.
 *
 * Pod logs and event messages are untrusted and routinely contain credentials
 * (env dumps, `Authorization` headers) and customer data. Redaction runs
 * **before** truncation so a secret split across a cut point cannot survive.
 *
 * The GitHub redactor is reused for `Bearer`/token-shaped runs; this module
 * adds the shapes its generic rules intentionally leave alone: `password=...`
 * assignments, JWTs (ServiceAccount/bound tokens) and email addresses.
 */

const PASSWORD_ASSIGNMENT =
	/(\b(?:password|passwd|pwd|secret|client[-_]?secret|api[-_]?key|access[-_]?key)\b\s*[:=]\s*)["']?[^\s"',;]{3,}["']?/gi;
const JWT_TOKEN =
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const EMAIL_ADDRESS = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** Kubernetes Secret/ConfigMap data dumps occasionally appear in logs. */
const PEM_PRIVATE_KEY =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Unbounded redaction for context excerpts: the bundle's character cap applies
 * after this function, so a credential fragment never reaches the cut point.
 */
export function redactKubernetesText(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	let out = redactSecretsUnbounded(text, extraSecrets);
	out = out.replace(PEM_PRIVATE_KEY, "[private-key-redacted]");
	out = out.replace(JWT_TOKEN, "[token-redacted]");
	out = out.replace(PASSWORD_ASSIGNMENT, "$1[redacted]");
	out = out.replace(EMAIL_ADDRESS, "[email-redacted]");
	return out;
}

/** Single-line, bounded variant for signal summaries and error-adjacent text. */
export function redactKubernetesLine(
	text: string,
	maxChars = 480,
	extraSecrets: readonly string[] = [],
): string {
	const collapsed = redactKubernetesText(text, extraSecrets)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return collapsed.length <= maxChars
		? collapsed
		: `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}
