import {
	MAX_SANITIZED_MESSAGE_LENGTH,
	redactSecretsUnbounded,
} from "../github/redact";

/**
 * PagerDuty PII redaction.
 *
 * Provider evidence is untrusted and may embed responder contact data even in
 * an allowlisted field (an incident title or a service name is free text). All
 * excerpt text funnels through here before truncation and hashing:
 *
 *  - emails, segmented phone numbers and contact-method phrases are replaced;
 *  - URL userinfo and credential-shaped runs are scrubbed by the shared
 *    redactor;
 *  - explicitly injected secrets (API token, `From` address) are removed
 *    verbatim when they are at least 8 characters long.
 *
 * Redaction runs before truncation so a secret split at the cut point cannot
 * survive as a fragment.
 */

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Segmented phone shapes only; ISO dates do not have two 3-4 digit groups. */
const PHONE_PATTERN =
	/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}/g;
/** Context-led digit runs (`phone 4155550100`) that lack separators. */
const CONTEXTUAL_PHONE_PATTERN =
	/\b(?:phone|tel|mobile|cell|sms|call)\b[^\n]{0,16}?\+?\d[\d().\s-]{5,}\d/gi;
const CONTACT_METHOD_PATTERN =
	/\b(?:contact\s*method|notification\s*target|notification\s*rule)\b[^\n]{0,48}/gi;
const URL_USERINFO_PATTERN = /\/\/[^\s/@]+@/g;

const EMAIL_MARKER = "[email-redacted]";
const PHONE_MARKER = "[phone-redacted]";
const CONTACT_MARKER = "[contact-redacted]";
const CREDENTIAL_MARKER = "[credentials-redacted]";

/** Replaces known PII shapes and injected secrets; no length cap. */
export function redactPagerDutyText(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	const withoutContactMethods = text.replace(
		CONTACT_METHOD_PATTERN,
		CONTACT_MARKER,
	);
	const withoutEmails = withoutContactMethods.replace(
		EMAIL_PATTERN,
		EMAIL_MARKER,
	);
	const withoutPhones = withoutEmails
		.replace(CONTEXTUAL_PHONE_PATTERN, PHONE_MARKER)
		.replace(PHONE_PATTERN, PHONE_MARKER);
	const withoutUserinfo = withoutPhones.replace(
		URL_USERINFO_PATTERN,
		`//${CREDENTIAL_MARKER}@`,
	);
	return redactSecretsUnbounded(withoutUserinfo, extraSecrets);
}

/**
 * Message-sized variant for tool results and fixed errors. Same redaction,
 * capped at the shared sanitized-message length.
 */
export function redactPagerDutyMessage(
	text: string,
	extraSecrets: readonly string[] = [],
): string {
	const out = redactPagerDutyText(text, extraSecrets);
	return out.length <= MAX_SANITIZED_MESSAGE_LENGTH
		? out
		: `${out.slice(0, MAX_SANITIZED_MESSAGE_LENGTH)}…`;
}
