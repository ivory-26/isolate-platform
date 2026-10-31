import { isIP } from "node:net";
import { redactSecretsUnbounded } from "../github/redact";

/**
 * Axiom-specific redaction (`docs/connectors/axiom.md` §9).
 *
 * Credential shapes delegate to the shared redactor. This layer adds the PII
 * classes the connector page forbids in model context: emails, IP addresses,
 * user/session identifiers and URL query strings. Redaction runs **before**
 * truncation, so a value split at a cut point cannot survive as a fragment.
 */

/** Bounded error text; provider text never leaves a tool uncapped. */
export const MAX_AXIOM_MESSAGE_CHARS = 480;

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_CANDIDATE_PATTERN = /\b[0-9A-Fa-f:]{2,45}\b/g;
const URL_QUERY_PATTERN = /\b(https?:\/\/[^\s?#]+)\?[^\s#]*/gi;
const IDENTIFIER_PATTERN =
	/\b(user_?id|session_?id|account_?id|tenant_?id|request_?id)\s*[:=]\s*["']?[^\s"',;]+["']?/gi;
const AXIOM_TOKEN_PATTERN = /\bx(?:ap|aa|ai)t[-_][A-Za-z0-9]{8,}/g;
const KEY_VALUE_SECRET_PATTERN =
	/(\b(?:password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*)(["']?)([^\s"',;]+)\2/gi;

export const AXIOM_REDACTION_MARKERS = {
	email: "[email-redacted]",
	ip: "[ip-redacted]",
	identifier: "[id-redacted]",
	query: "[query-redacted]",
	token: "[token-redacted]",
} as const;

/** Removes every known credential shape, PII class and injected secret. */
export function redactAxiomText(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	let out = redactSecretsUnbounded(text, extraSecrets);
	out = out.replace(AXIOM_TOKEN_PATTERN, AXIOM_REDACTION_MARKERS.token);
	out = out.replace(
		KEY_VALUE_SECRET_PATTERN,
		(_match, prefix: string, quote: string) =>
			`${prefix}${quote}[auth-redacted]${quote}`,
	);
	out = out.replace(EMAIL_PATTERN, AXIOM_REDACTION_MARKERS.email);
	out = out.replace(IPV4_PATTERN, AXIOM_REDACTION_MARKERS.ip);
	out = out.replace(IPV6_CANDIDATE_PATTERN, (candidate) =>
		candidate.includes(":") && isIP(candidate) === 6
			? AXIOM_REDACTION_MARKERS.ip
			: candidate,
	);
	out = out.replace(
		IDENTIFIER_PATTERN,
		(_match, name: string) => `${name}=${AXIOM_REDACTION_MARKERS.identifier}`,
	);
	out = out.replace(
		URL_QUERY_PATTERN,
		(_match, base: string) => `${base}?${AXIOM_REDACTION_MARKERS.query}`,
	);
	return out;
}

/** Redacted and capped for a tool failure message or a bounded error. */
export function redactAxiomMessage(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	const out = redactAxiomText(text, extraSecrets);
	return out.length <= MAX_AXIOM_MESSAGE_CHARS
		? out
		: `${out.slice(0, MAX_AXIOM_MESSAGE_CHARS - 1)}…`;
}
