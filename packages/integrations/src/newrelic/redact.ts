import { isIP } from "node:net";
import { redactSecretsUnbounded } from "../github/redact";

/**
 * New Relic text redaction (`docs/connectors/newrelic.md` §9).
 *
 * The shared GitHub redactor already removes `Bearer` values, token families
 * and long opaque credential runs. This layer adds the shapes New Relic
 * produces — user keys (`NRAK-…`), other key families, `API-Key` headers,
 * emails, IP addresses and account ids — so provider text can reach an excerpt
 * or a tool result without carrying a credential or PII.
 *
 * A bare number is indistinguishable from a metric, so account ids are only
 * removed when they appear in an account context (`accountId=…`,
 * `/accounts/<id>`). The configured account id is allowlisted: the reader
 * needs it for provenance, and it is not a human identity.
 *
 * Redaction runs before truncation, so a value split at the cut point cannot
 * survive as a fragment.
 */

export const MAX_NEWRELIC_MESSAGE_CHARS = 480;

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_CANDIDATE_PATTERN = /\b[0-9A-Fa-f:]{2,45}\b/g;
const NEWRELIC_KEY_PATTERN =
	/\b(?:NRAK|NRAA|NRIQ|NRJS|NRII|NRCX)-[A-Za-z0-9_-]{8,}\b/g;
const API_KEY_HEADER_PATTERN =
	/\b(api-key|api_key|x-api-key)\s*[:=]\s*[^\s,;"']+/gi;
const ACCOUNT_CONTEXT_PATTERN =
	/\b(account[ _-]?id|accounts?)(\s*[:=]\s*|\/)(["']?)([0-9]{1,12})\3/gi;

export const NEWRELIC_REDACTION_MARKERS = {
	email: "[email-redacted]",
	ip: "[ip-redacted]",
	key: "[token-redacted]",
	account: "[account-redacted]",
	header: "[header-redacted]",
} as const;

export type NewRelicRedactionOptions = {
	/** Configured account id that may remain in context. */
	allowAccountIds?: readonly string[];
	/** The user API key itself; scrubbed as an exact literal too. */
	extraSecrets?: readonly string[];
};

function redactAccountContext(
	text: string,
	allowAccountIds: readonly string[],
): string {
	return text.replace(
		ACCOUNT_CONTEXT_PATTERN,
		(match, label: string, separator: string, quote: string, id: string) => {
			if (allowAccountIds.includes(id)) return match;
			return `${label}${separator}${quote}${NEWRELIC_REDACTION_MARKERS.account}${quote}`;
		},
	);
}

/** Removes every known credential/PII shape; no length cap. */
export function redactNewRelicText(
	text: string,
	options: NewRelicRedactionOptions = {},
): string {
	const allowAccountIds = options.allowAccountIds ?? [];
	let out = redactSecretsUnbounded(text, options.extraSecrets ?? []);
	out = out.replace(
		API_KEY_HEADER_PATTERN,
		(_match, name: string) => `${name} ${NEWRELIC_REDACTION_MARKERS.header}`,
	);
	out = out.replace(NEWRELIC_KEY_PATTERN, NEWRELIC_REDACTION_MARKERS.key);
	out = out.replace(EMAIL_PATTERN, NEWRELIC_REDACTION_MARKERS.email);
	out = out.replace(IPV4_PATTERN, NEWRELIC_REDACTION_MARKERS.ip);
	out = out.replace(IPV6_CANDIDATE_PATTERN, (candidate) =>
		candidate.includes(":") && isIP(candidate) === 6
			? NEWRELIC_REDACTION_MARKERS.ip
			: candidate,
	);
	out = redactAccountContext(out, allowAccountIds);
	return out;
}

/** Redacted and capped for a tool result or an error message. */
export function redactNewRelicMessage(
	text: string,
	options: NewRelicRedactionOptions = {},
): string {
	const out = redactNewRelicText(text, options);
	return out.length <= MAX_NEWRELIC_MESSAGE_CHARS
		? out
		: `${out.slice(0, MAX_NEWRELIC_MESSAGE_CHARS - 1)}…`;
}
