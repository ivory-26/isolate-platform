import { describe, expect, test } from "bun:test";
import { CONNECTOR_IDS } from "../devices/contracts";
import {
	groupIntegrationCatalog,
	INTEGRATION_CATALOG,
	INTEGRATION_CATEGORIES,
	integrationCatalogEntry,
	isKnownEventKind,
} from "./catalog";

describe("integration catalog", () => {
	test("contains exactly the ten supported connectors in contract order", () => {
		expect(INTEGRATION_CATALOG.map((entry) => entry.id)).toEqual([
			...CONNECTOR_IDS,
		]);
	});

	test("every entry is complete, bounded and points at a connector doc", () => {
		for (const entry of INTEGRATION_CATALOG) {
			expect(entry.label.length).toBeGreaterThan(0);
			expect(entry.label.length).toBeLessThanOrEqual(64);
			expect(entry.description.length).toBeGreaterThan(0);
			expect(entry.description.length).toBeLessThanOrEqual(200);
			expect(INTEGRATION_CATEGORIES).toContain(entry.category);
			expect(entry.docsPath).toBe(`docs/connectors/${entry.id}.md`);
			expect(entry.freeTier.length).toBeGreaterThan(0);
			expect(entry.credentialHint.length).toBeGreaterThan(0);
			expect(entry.eventKinds.length).toBeGreaterThan(0);
			expect(entry.eventKinds.length).toBeLessThanOrEqual(16);
			expect(new Set(entry.eventKinds).size).toBe(entry.eventKinds.length);
			expect(new Set(entry.readTools.map((tool) => tool.name)).size).toBe(
				entry.readTools.length,
			);
			for (const tool of entry.readTools) {
				expect(tool.risk).toBe("read_only");
				expect(tool.description.length).toBeGreaterThan(0);
			}
			for (const tool of entry.actionTools) {
				expect(tool.risk).not.toBe("read_only");
			}
			expect(entry.capabilities.context).toBe(entry.readTools.length > 0);
			expect(entry.capabilities.actions).toBe(entry.actionTools.length > 0);
		}
	});

	test("keeps the three capabilities independent", () => {
		const kubernetes = integrationCatalogEntry("kubernetes");
		expect(kubernetes?.capabilities).toEqual({
			eventSource: false,
			context: true,
			actions: true,
		});
		const sentry = integrationCatalogEntry("sentry");
		expect(sentry?.capabilities).toEqual({
			eventSource: true,
			context: true,
			actions: false,
		});
		expect(
			INTEGRATION_CATALOG.some(
				(entry) =>
					entry.capabilities.eventSource && !entry.capabilities.actions,
			),
		).toBe(true);
		expect(
			INTEGRATION_CATALOG.some(
				(entry) =>
					!entry.capabilities.eventSource && entry.capabilities.context,
			),
		).toBe(true);
	});

	test("carries no secret-shaped string", () => {
		const shapes = [
			/gh[pousr]_[A-Za-z0-9]/i,
			/github_pat_[A-Za-z0-9_]/i,
			/AKIA[0-9A-Z]{16}/i,
			/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/i,
		];
		for (const entry of INTEGRATION_CATALOG) {
			const serialized = JSON.stringify(entry);
			for (const shape of shapes) {
				expect(shape.test(serialized)).toBe(false);
			}
		}
	});

	test("groups every entry once by category", () => {
		const groups = groupIntegrationCatalog();
		const ids = groups.flatMap((group) =>
			group.entries.map((entry) => entry.id),
		);
		expect(ids.sort()).toEqual([...CONNECTOR_IDS].sort());
		expect(groups.length).toBeGreaterThan(1);
	});

	test("validates event kinds against the connector, not a global list", () => {
		expect(isKnownEventKind("sentry", "issue_created")).toBe(true);
		expect(isKnownEventKind("sentry", "alert_firing")).toBe(false);
		expect(isKnownEventKind("kubernetes", "alert_firing")).toBe(false);
		expect(isKnownEventKind("unknown", "issue_created")).toBe(false);
	});

	test("returns undefined for an unknown connector id", () => {
		expect(integrationCatalogEntry("jenkins")).toBeUndefined();
	});
});
