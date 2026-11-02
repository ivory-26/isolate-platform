import { describe, expect, test } from "bun:test";
import { MAX_REPOSITORY_IMPORT_NAMES } from "./contracts";
import {
	canImport,
	isImportChoiceDisabled,
	MAX_IMPORT_SELECTION,
	pruneImportSelection,
	toggleImportSelection,
} from "./import-selection";

describe("repository import selection", () => {
	test("toggling adds and removes without duplicates", () => {
		const first = toggleImportSelection([], "acme/api");
		expect(first).toEqual({ selected: ["acme/api"], blocked: false });
		const second = toggleImportSelection(first.selected, "acme/web");
		expect(second.selected).toEqual(["acme/api", "acme/web"]);
		const removed = toggleImportSelection(second.selected, "acme/api");
		expect(removed).toEqual({ selected: ["acme/web"], blocked: false });
	});

	test("the cap mirrors the server import limit", () => {
		expect(MAX_IMPORT_SELECTION).toBe(MAX_REPOSITORY_IMPORT_NAMES);
		expect(MAX_IMPORT_SELECTION).toBe(25);
		const full = Array.from({ length: 25 }, (_, index) => `acme/repo-${index}`);
		const blocked = toggleImportSelection(full, "acme/one-more");
		expect(blocked.blocked).toBe(true);
		expect(blocked.selected).toHaveLength(25);
		// Unchecking an already-selected entry still works at the cap.
		const unchecked = toggleImportSelection(full, "acme/repo-0");
		expect(unchecked.blocked).toBe(false);
		expect(unchecked.selected).toHaveLength(24);
	});

	test("disabled choices and the import action follow the cap", () => {
		const full = Array.from({ length: 25 }, (_, index) => `acme/repo-${index}`);
		expect(isImportChoiceDisabled(full, "acme/repo-0")).toBe(false);
		expect(isImportChoiceDisabled(full, "acme/new")).toBe(true);
		expect(isImportChoiceDisabled([], "acme/new")).toBe(false);

		expect(canImport([])).toBe(false);
		expect(canImport(["acme/api"])).toBe(true);
		expect(canImport(Array.from({ length: 26 }, (_, i) => `acme/${i}`))).toBe(
			false,
		);
	});

	test("the selection is pruned to what the installation still offers", () => {
		expect(
			pruneImportSelection(
				["acme/api", "acme/gone", "acme/web"],
				["acme/api", "acme/web"],
			),
		).toEqual(["acme/api", "acme/web"]);
	});
});
