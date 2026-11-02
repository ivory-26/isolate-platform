import { describe, expect, test } from "bun:test";
import {
	buildRelayInstallScript,
	DEFAULT_RELAY_ARCHIVE_URL,
	handleRelayInstallRequest,
	normalizeRelayArchiveUrl,
} from "./relay-install.server";

describe("relay installer", () => {
	test("default archive is https", () => {
		expect(normalizeRelayArchiveUrl(DEFAULT_RELAY_ARCHIVE_URL)).toBe(
			DEFAULT_RELAY_ARCHIVE_URL,
		);
	});

	test("rejects archive URLs that are not safe https", () => {
		expect(normalizeRelayArchiveUrl("http://example.com/relay.tgz")).toBeNull();
		expect(
			normalizeRelayArchiveUrl("https://user:pass@example.com/relay.tgz"),
		).toBeNull();
		expect(
			normalizeRelayArchiveUrl("https://example.com/relay.tgz?token=1"),
		).toBeNull();
		expect(
			normalizeRelayArchiveUrl("https://example.com/relay.tgz#fragment"),
		).toBeNull();
	});

	test("script installs dependencies, writes private config, and starts the daemon", () => {
		const script = buildRelayInstallScript();
		expect(script.startsWith("#!/bin/sh\nset -eu")).toBe(true);
		expect(script).toContain("--server");
		expect(script).toContain("--token");
		expect(script).toContain("bun install --frozen-lockfile");
		expect(script).toContain("47821");
		expect(script).toContain("apps/device-daemon/src/index.ts");
		expect(script).toContain("chmod 600");
		expect(script).not.toContain("set -x");
		expect(script).toContain("ISOLATE_DEVICE_TOKEN=$TOKEN");
	});

	test("serves the script with no-store and a shell content type", async () => {
		const response = handleRelayInstallRequest();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"text/x-shellscript",
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toContain("bun install --frozen-lockfile");
	});
});
