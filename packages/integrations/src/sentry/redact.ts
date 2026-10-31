import { isIP } from "node:net";
import { redactSecretsUnbounded } from "../github/redact";

/**
 * Sentry text redaction. Credential shapes delegate to the shared redactor;
 * this layer adds the PII classes the connector spec forbids in model context
 * (emails, IP addresses, cookies, auth headers, DSNs).
 *
 * Redaction runs before truncation, so a value split at a cut point cannot
 * survive as a fragment.
 */

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_CANDIDATE_PATTERN = /\b[0-9A-Fa-f:]{2,45}\b/g;
const HEADER_PATTERN =
	/\b(authorization|proxy-authorization|set-cookie|cookie)\s*[:=]\s*[^\n]*/gi;
const DSN_PATTERN =
	/\b(?:https?:\/\/)?[0-9a-f]{16,}@[A-Za-z0-9.-]*sentry\.io\/\d+/gi;

export const SENTRY_REDACTION_MARKERS = {
	email: "[email-redacted]",
	ip: "[ip-redacted]",
	header: "[header-redacted]",
	dsn: "[dsn-redacted]",
} as const;

export function redactSentryText(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	let out = redactSecretsUnbounded(text, extraSecrets);
	out = out.replace(EMAIL_PATTERN, SENTRY_REDACTION_MARKERS.email);
	out = out.replace(IPV4_PATTERN, SENTRY_REDACTION_MARKERS.ip);
	out = out.replace(IPV6_CANDIDATE_PATTERN, (candidate) =>
		candidate.includes(":") && isIP(candidate) === 6
			? SENTRY_REDACTION_MARKERS.ip
			: candidate,
	);
	out = out.replace(DSN_PATTERN, SENTRY_REDACTION_MARKERS.dsn);
	out = out.replace(
		HEADER_PATTERN,
		(_match, name: string) => `${name} ${SENTRY_REDACTION_MARKERS.header}`,
	);
	return out;
}
