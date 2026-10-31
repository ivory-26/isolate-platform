import { describe, expect, test } from "bun:test";
import { GRAFANA_DEFAULT_TIMESTAMP_HEADER } from "./incident-intake-grafana.server";
import {
	getIncidentIntake,
	hasConfiguredIntakeMode,
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
const SENTRY_SECRET = "fabricated-sentry-secret-0123456789";
const GRAFANA_SECRET = "fabricated-grafana-secret-0123456789abcdef";
const PAGERDUTY_SECRET = "fabricated-pagerduty-secret-0123456789abcdef";

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

	test("first-batch adapter secrets are optional and independent", () => {
		const sentry = readIncidentIntakeSettings({
			...binding,
			WEBHOOK_SENTRY_SECRET: SENTRY_SECRET,
		});
		expect(sentry?.sentrySecret).toBe(SENTRY_SECRET);
		expect(sentry?.grafanaSecret).toBeUndefined();
		expect(sentry?.pagerdutySecret).toBeUndefined();
		expect(sentry?.signingSecret).toBeUndefined();
		expect(sentry?.grafanaAllowUnsigned).toBe(false);
		expect(sentry?.grafanaTimestampHeader).toBe(
			GRAFANA_DEFAULT_TIMESTAMP_HEADER,
		);

		const grafana = readIncidentIntakeSettings({
			...binding,
			WEBHOOK_GRAFANA_SECRET: GRAFANA_SECRET,
		});
		expect(grafana?.grafanaSecret).toBe(GRAFANA_SECRET);
		expect(grafana?.sentrySecret).toBeUndefined();

		const pagerduty = readIncidentIntakeSettings({
			...binding,
			WEBHOOK_PAGERDUTY_SECRET: PAGERDUTY_SECRET,
		});
		expect(pagerduty?.pagerdutySecret).toBe(PAGERDUTY_SECRET);
		expect(pagerduty?.grafanaSecret).toBeUndefined();
	});

	test("a short adapter secret is rejected rather than half-configured", () => {
		for (const name of [
			"WEBHOOK_SENTRY_SECRET",
			"WEBHOOK_GRAFANA_SECRET",
			"WEBHOOK_PAGERDUTY_SECRET",
		])
			expect(readIncidentIntakeSettings({ ...binding, [name]: "short" })).toBe(
				null,
			);
	});

	test("unsigned Grafana requires the literal true flag", () => {
		const enabled = readIncidentIntakeSettings({
			...binding,
			WEBHOOK_GRAFANA_ALLOW_UNSIGNED: " TRUE ",
		});
		expect(enabled?.grafanaAllowUnsigned).toBe(true);
		expect(enabled?.grafanaSecret).toBeUndefined();
		for (const value of ["yes", "1", "false", ""])
			expect(
				readIncidentIntakeSettings({
					...binding,
					WEBHOOK_GRAFANA_ALLOW_UNSIGNED: value,
				})?.grafanaAllowUnsigned,
			).toBe(false);
	});

	test("the Grafana timestamp header defaults and can be overridden", () => {
		const overridden = readIncidentIntakeSettings({
			...binding,
			GRAFANA_WEBHOOK_TIMESTAMP_HEADER: "x-custom-timestamp",
		});
		expect(overridden?.grafanaTimestampHeader).toBe("x-custom-timestamp");
		expect(
			readIncidentIntakeSettings({
				...binding,
				GRAFANA_WEBHOOK_TIMESTAMP_HEADER: "not a header",
			}),
		).toBeNull();
	});

	test("any adapter secret or the unsigned opt-in configures intake", () => {
		const bare = readIncidentIntakeSettings(binding);
		expect(bare).not.toBeNull();
		if (bare === null) throw new Error("Expected binding settings");
		expect(hasConfiguredIntakeMode(bare)).toBe(false);
		const sentry = readIncidentIntakeSettings({
			...binding,
			WEBHOOK_SENTRY_SECRET: SENTRY_SECRET,
		});
		expect(sentry !== null && hasConfiguredIntakeMode(sentry)).toBe(true);
		const unsigned = readIncidentIntakeSettings({
			...binding,
			WEBHOOK_GRAFANA_ALLOW_UNSIGNED: "true",
		});
		expect(unsigned !== null && hasConfiguredIntakeMode(unsigned)).toBe(true);
	});
});
