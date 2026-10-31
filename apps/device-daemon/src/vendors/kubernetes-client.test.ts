import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
	createKubernetesHttpsClient,
	expandHomePath,
} from "./kubernetes-client";

describe("kubernetes https client", () => {
	test("rejects a non-https api url without echoing it", () => {
		expect(() =>
			createKubernetesHttpsClient({
				apiUrl: "http://127.0.0.1:6443",
				serviceAccountTokenFile: "/tmp/token",
			}),
		).toThrow("kubernetes api url is invalid");
	});

	test("rejects an api url with credentials", () => {
		expect(() =>
			createKubernetesHttpsClient({
				apiUrl: "https://user:pass@127.0.0.1:6443",
				serviceAccountTokenFile: "/tmp/token",
			}),
		).toThrow("kubernetes api url is invalid");
	});

	test("expands a leading home marker", () => {
		expect(expandHomePath("~")).toBe(homedir());
		expect(expandHomePath("~/.isolate/k8s-token")).toBe(
			`${homedir()}/.isolate/k8s-token`,
		);
		expect(expandHomePath("/tmp/token")).toBe("/tmp/token");
	});

	test("fails closed when the token file is unreadable", async () => {
		const client = createKubernetesHttpsClient({
			apiUrl: "https://127.0.0.1:6443",
			serviceAccountTokenFile: "/definitely/missing/isolate-token",
		});
		await expect(client.get("/api/v1/namespaces/default/pods")).rejects.toThrow(
			"kubernetes service account token could not be read",
		);
	});
});
