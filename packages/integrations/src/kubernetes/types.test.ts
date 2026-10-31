import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	assertKubernetesApiPath,
	isBoundedKubernetesApiUrl,
	isKubernetesApiPath,
	KUBERNETES_CONFIG_ENV_NAMES,
	KUBERNETES_NAME_PATTERN,
	KUBERNETES_NAMESPACE_PATTERN,
	parseKubernetesConnectorConfig,
} from "./types";

const CONFIG = {
	apiUrl: "https://kubernetes.default.svc",
	namespace: "payments",
	caFile: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
	serviceAccountTokenFile:
		"/var/run/secrets/kubernetes.io/serviceaccount/token",
};

function configError(input: unknown): PlatformError | undefined {
	try {
		parseKubernetesConnectorConfig(input);
	} catch (thrown) {
		return thrown as PlatformError;
	}
	return undefined;
}

describe("kubernetes connector configuration", () => {
	test("accepts a file-based, https-only configuration", () => {
		const parsed = parseKubernetesConnectorConfig(CONFIG);
		expect(parsed.apiUrl).toBe(CONFIG.apiUrl);
		expect(parsed.namespace).toBe("payments");
		expect(parsed.clusterId).toBe("cluster");
		expect(parsed.caFile).toBe(CONFIG.caFile);
		expect(parsed.serviceAccountTokenFile).toBe(CONFIG.serviceAccountTokenFile);
		expect(KUBERNETES_CONFIG_ENV_NAMES).toContain("KUBERNETES_API_URL");
	});

	test("rejects non-https, credentialed and query-bearing API URLs", () => {
		for (const apiUrl of [
			"http://kubernetes.default.svc",
			"https://user:pass@kubernetes.default.svc",
			"https://kubernetes.default.svc?token=abc",
			"https://kubernetes.default.svc/#fragment",
			"kubernetes.default.svc",
		]) {
			const error = configError({ ...CONFIG, apiUrl });
			expect(error).toBeInstanceOf(PlatformError);
			expect(error?.code).toBe("VALIDATION_FAILED");
			expect(String(error?.message)).not.toContain("pass");
		}
	});

	test("rejects a kubeconfig or an inline token instead of ignoring it", () => {
		for (const extra of [
			{ kubeconfig: "/home/agent/.kube/config" },
			{ token: "inline-service-account-token" },
			{ KUBECONFIG: "/home/agent/.kube/config" },
			{ apiUrl: "https://kubernetes.default.svc", unknownKey: true },
		]) {
			const error = configError({ ...CONFIG, ...extra });
			expect(error).toBeInstanceOf(PlatformError);
			expect(error?.code).toBe("VALIDATION_FAILED");
		}
	});

	test("rejects an invalid namespace or a multi-line file path", () => {
		expect(configError({ ...CONFIG, namespace: "Bad_NS" })?.code).toBe(
			"VALIDATION_FAILED",
		);
		expect(
			configError({ ...CONFIG, serviceAccountTokenFile: "/a\n/b" })?.code,
		).toBe("VALIDATION_FAILED");
		expect(configError({ ...CONFIG, namespace: undefined })?.code).toBe(
			"VALIDATION_FAILED",
		);
	});

	test("validates the documented API URL form", () => {
		expect(isBoundedKubernetesApiUrl(CONFIG.apiUrl)).toBe(true);
		expect(isBoundedKubernetesApiUrl("https://10.0.0.1:6443")).toBe(true);
		expect(isBoundedKubernetesApiUrl("http://10.0.0.1:6443")).toBe(false);
	});
});

describe("kubernetes API path guard", () => {
	test("accepts only namespaced read paths", () => {
		for (const path of [
			"/api/v1/namespaces/payments/events",
			"/api/v1/namespaces/payments/pods/api-7c9f-abc",
			"/api/v1/namespaces/payments/pods/api-7c9f-abc/log",
			"/apis/apps/v1/namespaces/payments/deployments/api",
			"/apis/apps/v1/namespaces/payments/replicasets",
		]) {
			expect(isKubernetesApiPath(path)).toBe(true);
			expect(() => assertKubernetesApiPath(path)).not.toThrow();
		}
	});

	test("refuses secrets, configmaps, exec, attach, portforward and tokens", () => {
		for (const path of [
			"/api/v1/namespaces/payments/secrets",
			"/api/v1/namespaces/payments/secrets/db-creds",
			"/api/v1/namespaces/payments/configmaps",
			"/api/v1/namespaces/payments/pods/api/exec",
			"/api/v1/namespaces/payments/pods/api/attach",
			"/api/v1/namespaces/payments/pods/api/portforward",
			"/api/v1/namespaces/payments/serviceaccounts/default/token",
			"/api/v1/namespaces/payments/pods",
			"/api/v1/nodes/node-1",
			"/apis/batch/v1/namespaces/payments/jobs",
		]) {
			expect(isKubernetesApiPath(path)).toBe(false);
			expect(() => assertKubernetesApiPath(path)).toThrow(PlatformError);
		}
	});

	test("refuses absolute URLs, traversal and query strings", () => {
		for (const path of [
			"https://evil.example.com/api/v1/namespaces/payments/events",
			"//evil.example.com/api/v1/namespaces/payments/events",
			"/api/v1/namespaces/payments/../../secrets",
			"/api/v1/namespaces/payments/pods/api?follow=true",
			"/api/v1/namespaces/payments\\pods\\api",
		]) {
			expect(isKubernetesApiPath(path)).toBe(false);
		}
	});
});

describe("kubernetes identifier patterns", () => {
	test("namespace and resource names are lowercase RFC 1123", () => {
		expect(KUBERNETES_NAMESPACE_PATTERN.test("payments")).toBe(true);
		expect(KUBERNETES_NAMESPACE_PATTERN.test("pay-ments-1")).toBe(true);
		expect(KUBERNETES_NAMESPACE_PATTERN.test("Payments")).toBe(false);
		expect(KUBERNETES_NAME_PATTERN.test("api-7c9f-abc")).toBe(true);
		expect(KUBERNETES_NAME_PATTERN.test("api.dev-1")).toBe(true);
		expect(KUBERNETES_NAME_PATTERN.test("api/../admin")).toBe(false);
	});
});
