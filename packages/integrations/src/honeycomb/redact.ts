import { isIP } from "node:net";
import { redactSecretsUnbounded } from "../github/redact";

/**
 * Honeycomb text redaction (`docs/connectors/honeycomb.md` §9).
 *
 * Credential shapes delegate to the shared redactor. This layer adds the PII
 * classes the connector spec forbids in model context: email addresses, IP
 * addresses and hostname-valued fields. Redaction always runs before
 * truncation, so a value split at a cut point cannot survive as a fragment.
 *
 * The API key and webhook token are passed as `extraSecrets`; they are never
 * logged, echoed in an error or written to a fixture.
 */

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_CANDIDATE_PATTERN = /\b[0-9A-Fa-f:]{2,45}\b/g;
const HOST_FIELD_PATTERN =
	/\b((?:host|hostname|host\.name|server\.name|k8s\.node\.name|node\.name))\s*[:=]\s*[^\s,;]+/gi;

export const HONEYCOMB_REDACTION_MARKERS = {
	email: "[email-redacted]",
	ip: "[ip-redacted]",
	host: "[host-redacted]",
} as const;

export function redactHoneycombText(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	let out = redactSecretsUnbounded(text, extraSecrets);
	out = out.replace(EMAIL_PATTERN, HONEYCOMB_REDACTION_MARKERS.email);
	out = out.replace(IPV4_PATTERN, HONEYCOMB_REDACTION_MARKERS.ip);
	out = out.replace(IPV6_CANDIDATE_PATTERN, (candidate) =>
		candidate.includes(":") && isIP(candidate) === 6
			? HONEYCOMB_REDACTION_MARKERS.ip
			: candidate,
	);
	out = out.replace(
		HOST_FIELD_PATTERN,
		(_match, name: string) => `${name} ${HONEYCOMB_REDACTION_MARKERS.host}`,
	);
	return out;
}
