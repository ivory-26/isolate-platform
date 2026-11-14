import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runBench } from "./bench-connectors";

/**
 * Determinism proof for the offline connector benchmark (project/BENCHMARK-PLAN.md).
 *
 * The compared payload carries no timestamps, task ids or wall-clock durations,
 * so two consecutive runs must be byte-identical. Every provider transport is a
 * fake; no environment file is read and no network call is made.
 */

const CONNECTORS = [
	"github",
	"sentry",
	"grafana",
	"pagerduty",
	"datadog",
	"newrelic",
	"honeycomb",
	"axiom",
	"signoz",
	"kubernetes",
] as const;

describe("bench-connectors", () => {
	test("runs deterministically and every scenario passes", async () => {
		const first = await runBench();
		const second = await runBench();
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.totals.failed).toBe(0);
		expect(first.totals.scenarios).toBe(first.scenarios.length);
		expect(first.providerCalls).toBe(0);
		expect(first.liveMode).toBe(false);
	}, 120_000);

	test("covers every supported connector and the negative cases", async () => {
		const summary = await runBench();
		const names = new Set(summary.scenarios.map((scenario) => scenario.name));

		for (const connector of CONNECTORS) {
			const intake =
				connector === "github" ||
				connector === "sentry" ||
				connector === "grafana" ||
				connector === "pagerduty"
					? `intake/${connector}-`
					: `intake/generic-${connector}`;
			const intakeName = [...names].find((name) =>
				name.startsWith(intake),
			);
			expect(intakeName, `intake scenario for ${connector}`).toBeDefined();
			expect(names.has(`evidence/${connector}`)).toBe(true);
		}

		expect(names.has("intake/bad-signature-rejected")).toBe(true);
		expect(names.has("intake/replay-deduped")).toBe(true);
		expect(names.has("intake/autonomy-a1-unsupported")).toBe(true);
		expect(names.has("evidence/empty-device-degrades")).toBe(true);
	}, 120_000);

	test("the compared summary contains no timestamps, ids or wall clocks", async () => {
		const summary = await runBench();
		const payload = JSON.stringify(summary);
		expect(payload).not.toContain("fetchedAt");
		expect(payload).not.toContain("receivedAt");
		expect(payload).not.toContain("2026-");
		expect(payload).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
		expect(payload).not.toMatch(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
		);
	}, 120_000);

	test("every evidence scenario is non-empty except the degrade case", async () => {
		const summary = await runBench();
		for (const scenario of summary.scenarios) {
			if (scenario.group !== "evidence") continue;
			if (scenario.name === "evidence/empty-device-degrades") {
				expect(scenario.evidenceItems).toBe(0);
				expect(scenario.evidenceDigest).toBeNull();
				expect(scenario.pass).toBe(true);
				continue;
			}
			expect(scenario.evidenceItems, scenario.name).toBeGreaterThan(0);
			expect(scenario.evidenceDigest, scenario.name).toMatch(/^[0-9a-f]{64}$/);
		}
	}, 120_000);

	test("live mode is inert and never contacts a vendor", async () => {
		const script = fileURLToPath(
			new URL("./bench-connectors.ts", import.meta.url),
		);
		const child = Bun.spawn([process.execPath, script], {
			env: { ...process.env, BENCH_LIVE: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("skipped: live mode requires explicit approval");
	}, 60_000);
});
