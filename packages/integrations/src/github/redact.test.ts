import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./redact";

const GITHUB_TOKEN = "ghp_fabricated1234567890abc";
const INSTALLATION_TOKEN = "ghs_fabricated_inst_987654321";
const FINEGRAINED_TOKEN = "github_pat_fabricated1234567890ab";
const OPAQUE_43 = "ABCDEFGHIJKLMNOP-RSTUVWXYZabcdefghij0123456789";

describe("redactSecrets", () => {
	test("removes github PAT and installation token shapes", () => {
		const input = `bad creds ${GITHUB_TOKEN} and ${FINEGRAINED_TOKEN} and ${INSTALLATION_TOKEN}`;
		const out = redactSecrets(input);
		expect(out).not.toContain(GITHUB_TOKEN);
		expect(out).not.toContain(FINEGRAINED_TOKEN);
		expect(out).not.toContain("fabricated");
		expect(out).toContain("[token-redacted]");
	});

	test("removes bearer-style authorization material", () => {
		const out = redactSecrets(
			`Authorization: Bearer ${GITHUB_TOKEN} got rejected`,
		);
		expect(out).not.toContain(GITHUB_TOKEN);
		expect(out).toContain("Bearer [auth-redacted]");
	});

	test("removes an explicitly injected credential verbatim", () => {
		const out = redactSecrets(
			"upstream said your ghs_fix_0123456789 is invalid",
			["ghs_fix_0123456789"],
		);
		expect(out).not.toContain("ghs_fix_0123456789");
		expect(out).toContain("[token-redacted]");
	});

	test("removes long opaque secret runs", () => {
		const out = redactSecrets(`leaked ${OPAQUE_43} in body`);
		expect(out).not.toContain(OPAQUE_43);
		expect(out).toContain("[redacted]");
	});

	test("caps the sanitized message length", () => {
		const out = redactSecrets("x".repeat(5_000));
		expect(out.length).toBeLessThanOrEqual(481);
		expect(out.endsWith("…")).toBe(true);
	});

	test("leaves credential-free text intact", () => {
		expect(redactSecrets("pull request created for owner/name")).toBe(
			"pull request created for owner/name",
		);
	});
});
