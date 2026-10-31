import { describe, expect, test } from "bun:test";
import {
	getIncidentIntake,
	IncidentIntakeNotConfiguredError,
	readIncidentIntakeSettings,
} from "./incident-intake-runtime.server";

/**
 * Binding configuration only: no database is opened and no secret is read from
 * the environment file. Every value here is fabricated.
 */
const binding = {
	WEBHOOK_ORGANIZATION_ID: "10000000-0000-4000-8000-000000000001",
	WEBHOOK_ACTOR_ID: "10000000-0000-4000-8000-000000000002",
	WEBHOOK_REPOSITORY_ID: "10000000-0000-4000-8000-000000000003",
	WEBHOOK_BRANCH: "main",
	WEBHOOK_WORKFLOW_DEFINITION_ID: "10000000-0000-4000-8000-000000000004",
	WEBHOOK_WORKFLOW_VERSION: "1",
};
const GENERIC_SECRET = "fabricated-generic-secret-0123456789abcdef";
const GITHUB_SECRET = "fabricated-github-secret-0123456789abcdef";

describe("incident intake settings", () => {
	test("each mode secret is optional and independent", () => {
		const generic = readIncidentIntakeSettings({
			...binding,
			WEBHOOK_SIGNING_SECRET: GENERIC_SECRET,
		});
		expect(generic?.signingSecret).toBe(GENERIC_SECRET);
		expect(generic?.githubSecret).toBeUndefined();
		expect(generic?.branch).toBe("main");

		const github = readIncidentIntakeSettings({
			...binding,
			WEBHOOK_GITHUB_SECRET: GITHUB_SECRET,
		});
		expect(github?.githubSecret).toBe(GITHUB_SECRET);
		expect(github?.signingSecret).toBeUndefined();
	});

	test("an empty secret is not configured, and short secrets are rejected", () => {
		const empty = readIncidentIntakeSettings({
			...binding,
			WEBHOOK_SIGNING_SECRET: "",
			WEBHOOK_GITHUB_SECRET: "   ",
		});
		expect(empty?.signingSecret).toBeUndefined();
		expect(empty?.githubSecret).toBeUndefined();
		expect(
			readIncidentIntakeSettings({
				...binding,
				WEBHOOK_GITHUB_SECRET: "too-short",
			}),
		).toBeNull();
	});

	test("missing binding, both secrets or the database URL is not configured", () => {
		expect(
			readIncidentIntakeSettings({
				WEBHOOK_SIGNING_SECRET: GENERIC_SECRET,
			}),
		).toBeNull();
		const unconfigured = { ...binding, WEBHOOK_SIGNING_SECRET: "" };
		expect(() => getIncidentIntake(unconfigured)).toThrow(
			IncidentIntakeNotConfiguredError,
		);
		expect(() =>
			getIncidentIntake({
				...binding,
				WEBHOOK_GITHUB_SECRET: GITHUB_SECRET,
			}),
		).toThrow(IncidentIntakeNotConfiguredError);
		expect(() =>
			getIncidentIntake({
				...binding,
				WEBHOOK_GITHUB_SECRET: GITHUB_SECRET,
				DATABASE_URL: "",
			}),
		).toThrow(IncidentIntakeNotConfiguredError);
	});
});
