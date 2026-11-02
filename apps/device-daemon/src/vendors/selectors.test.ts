import { describe, expect, test } from "bun:test";
import {
	getPairingSpec,
	PAIRING_FIELD_ERROR_CODES,
	parsePairingSubmission,
	resolveOptionalSelector,
	resolveRequiredSelector,
	VENDOR_PAIRING_SPECS,
} from "./selectors";

const REF = "keychain:isolate/test";

function parse(
	connectorId: string,
	secretFields: Record<string, string>,
	selectorFields: Record<string, string> = {},
) {
	return parsePairingSubmission(connectorId, {
		secretFields,
		selectorFields,
	});
}

describe("vendor pairing specs", () => {
	test("covers the nine connectors with the documented secret fields", () => {
		expect(VENDOR_PAIRING_SPECS.map((spec) => spec.connectorId)).toEqual([
			"sentry",
			"grafana",
			"pagerduty",
			"kubernetes",
			"datadog",
			"newrelic",
			"honeycomb",
			"axiom",
			"signoz",
		]);
		const secrets = Object.fromEntries(
			VENDOR_PAIRING_SPECS.map((spec) => [
				spec.connectorId,
				spec.secrets.map((field) => field.key),
			]),
		);
		expect(secrets).toEqual({
			sentry: ["token"],
			grafana: ["token"],
			pagerduty: ["token"],
			kubernetes: ["serviceAccountTokenFile", "caFile"],
			datadog: ["apiKey", "appKey"],
			newrelic: ["apiKey"],
			honeycomb: ["apiKey"],
			axiom: ["token"],
			signoz: ["apiKey"],
		});
	});

	test("marks only the optional fields optional", () => {
		const k8s = getPairingSpec("kubernetes");
		expect(k8s?.secrets.find((f) => f.key === "caFile")?.required).toBe(false);
		expect(
			k8s?.secrets.find((f) => f.key === "serviceAccountTokenFile")?.required,
		).toBe(true);
		const grafana = getPairingSpec("grafana");
		expect(grafana?.selectors.find((f) => f.key === "baseUrl")?.required).toBe(
			true,
		);
		expect(grafana?.selectors.find((f) => f.key === "orgId")?.required).toBe(
			false,
		);
	});

	test("an unknown or malformed connector has no guided form", () => {
		expect(getPairingSpec("github")).toBeNull();
		expect(getPairingSpec("Sentry")).toBeNull();
		expect(getPairingSpec("../sentry")).toBeNull();
		expect(getPairingSpec(null)).toBeNull();
	});
});

describe("pairing submission parsing", () => {
	test("normalizes a Grafana URL and keeps optional datasource UIDs", () => {
		const result = parse(
			"grafana",
			{ token: "  token-value  " },
			{
				baseUrl: "https://grafana.example.com/",
				orgId: " 7 ",
				metricsDatasourceUid: "metrics-1",
			},
		);
		expect(result).toEqual({
			ok: true,
			value: {
				fields: { token: "token-value" },
				selectors: {
					baseUrl: "https://grafana.example.com",
					orgId: "7",
					metricsDatasourceUid: "metrics-1",
				},
			},
		});
	});

	test("accepts Datadog's two named keys", () => {
		const result = parse(
			"datadog",
			{ apiKey: "api", appKey: "app" },
			{
				baseUrl: "https://api.datadoghq.com",
			},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.fields).toEqual({ apiKey: "api", appKey: "app" });
		expect(result.value.selectors).toEqual({
			baseUrl: "https://api.datadoghq.com",
		});
	});

	test("accepts Kubernetes token path, API URL and namespace", () => {
		const result = parse(
			"kubernetes",
			{
				serviceAccountTokenFile:
					"/var/run/secrets/kubernetes.io/serviceaccount/token",
			},
			{
				apiUrl: "https://cluster.example.com:6443",
				namespace: "production",
				clusterId: "prod-eu",
			},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.selectors).toEqual({
			apiUrl: "https://cluster.example.com:6443",
			namespace: "production",
			clusterId: "prod-eu",
		});
	});

	test("rejects an unknown field", () => {
		expect(parse("sentry", { token: "x" }, { orgSlug: "acme" })).toEqual({
			ok: false,
			code: "UNKNOWN_FIELD",
		});
		expect(parse("sentry", { apiKey: "x" })).toEqual({
			ok: false,
			code: "UNKNOWN_FIELD",
		});
		expect(parse("sentry", { token: "x", extra: "" })).toEqual({
			ok: false,
			code: "UNKNOWN_FIELD",
		});
	});

	test("rejects a missing or empty required value", () => {
		expect(parse("sentry", {})).toEqual({
			ok: false,
			code: "MISSING_REQUIRED",
		});
		expect(parse("sentry", { token: "   " })).toEqual({
			ok: false,
			code: "MISSING_REQUIRED",
		});
		expect(parse("grafana", { token: "x" }, { baseUrl: "" })).toEqual({
			ok: false,
			code: "MISSING_REQUIRED",
		});
		expect(
			parse(
				"datadog",
				{ apiKey: "a" },
				{ baseUrl: "https://api.datadoghq.com" },
			),
		).toEqual({ ok: false, code: "MISSING_REQUIRED" });
	});

	test("rejects an invalid selector shape", () => {
		expect(
			parse("grafana", { token: "x" }, { baseUrl: "http://plain.example.com" }),
		).toEqual({ ok: false, code: "INVALID_VALUE" });
		expect(
			parse(
				"grafana",
				{ token: "x" },
				{
					baseUrl: "https://grafana.example.com",
					orgId: "one",
				},
			),
		).toEqual({ ok: false, code: "INVALID_VALUE" });
		expect(
			parse(
				"kubernetes",
				{ serviceAccountTokenFile: "/tmp/token" },
				{
					apiUrl: "https://cluster.example.com",
					namespace: "Not_A_Label",
				},
			),
		).toEqual({ ok: false, code: "INVALID_VALUE" });
		expect(parse("pagerduty", { token: "x" }, { fromEmail: "nope" })).toEqual({
			ok: false,
			code: "INVALID_VALUE",
		});
	});

	test("rejects a credential-shaped selector", () => {
		const result = parse(
			"honeycomb",
			{ apiKey: "x" },
			{
				dataset: "Bearer abcdefghij",
			},
		);
		expect(result).toEqual({
			ok: false,
			code: "CREDENTIAL_IN_SELECTOR",
		});
	});

	test("bounds long values", () => {
		expect(parse("sentry", { token: "x".repeat(8_193) })).toEqual({
			ok: false,
			code: "INVALID_VALUE",
		});
		expect(
			parse("honeycomb", { apiKey: "x" }, { dataset: "d".repeat(129) }),
		).toEqual({ ok: false, code: "INVALID_VALUE" });
	});

	test("the error code list is closed", () => {
		expect([...PAIRING_FIELD_ERROR_CODES]).toEqual([
			"UNKNOWN_CONNECTOR",
			"UNKNOWN_FIELD",
			"MISSING_REQUIRED",
			"INVALID_VALUE",
			"CREDENTIAL_IN_SELECTOR",
		]);
	});
});

describe("call-time selector precedence", () => {
	const store = {
		getFields: () => ({ token: "stored" }),
		getSelectors: (ref: string) =>
			ref === REF
				? {
						baseUrl: "https://paired.example.com",
						orgId: "9",
					}
				: null,
	};

	test("paired selector beats static config and env", () => {
		expect(
			resolveRequiredSelector({
				connectorId: "grafana",
				key: "baseUrl",
				credentialRef: REF,
				store,
				configValue: "https://config.example.com",
				envValue: "https://env.example.com",
			}),
		).toEqual({ ok: true, value: "https://paired.example.com" });
	});

	test("static config beats env when no paired value exists", () => {
		expect(
			resolveOptionalSelector({
				connectorId: "kubernetes",
				key: "apiUrl",
				credentialRef: "keychain:isolate/other",
				store,
				configValue: "https://config.example.com",
				envValue: "https://env.example.com",
			}),
		).toEqual({ ok: true, value: "https://config.example.com" });
	});

	test("env remains the final fallback", () => {
		expect(
			resolveRequiredSelector({
				connectorId: "kubernetes",
				key: "namespace",
				credentialRef: "keychain:isolate/other",
				store,
				configValue: undefined,
				envValue: "production",
			}),
		).toEqual({ ok: true, value: "production" });
	});

	test("a malformed paired value fails instead of falling back", () => {
		expect(
			resolveRequiredSelector({
				connectorId: "grafana",
				key: "baseUrl",
				credentialRef: "keychain:isolate/bad",
				store: {
					getFields: () => ({ token: "stored" }),
					getSelectors: () => ({ baseUrl: "http://plain.example.com" }),
				},
				configValue: "https://config.example.com",
			}),
		).toEqual({ ok: false, reason: "INVALID_SELECTOR" });
	});

	test("a missing required selector is CONFIG_REQUIRED", () => {
		expect(
			resolveRequiredSelector({
				connectorId: "grafana",
				key: "baseUrl",
				credentialRef: REF,
				store: { getFields: () => ({ token: "stored" }) },
			}),
		).toEqual({ ok: false, reason: "CONFIG_REQUIRED" });
	});

	test("a store without getSelectors keeps compiling and resolves no selector", () => {
		expect(
			resolveOptionalSelector({
				connectorId: "sentry",
				key: "baseUrl",
				credentialRef: REF,
				store: { getFields: () => ({ token: "stored" }) },
			}),
		).toEqual({ ok: true, value: undefined });
	});
});
