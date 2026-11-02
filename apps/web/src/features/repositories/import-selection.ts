import { MAX_REPOSITORY_IMPORT_NAMES } from "./contracts";

/**
 * Pure picker model for the GitHub import panel. Selection is a list of full
 * names; the cap mirrors `importRepositoriesSchema`, so the UI can never build
 * a request the server would reject.
 */

export const MAX_IMPORT_SELECTION = MAX_REPOSITORY_IMPORT_NAMES;

export type ToggleResult = {
	selected: string[];
	/** True when the click was ignored because the cap was reached. */
	blocked: boolean;
};

/** Adds or removes one full name; never exceeds the import cap. */
export function toggleImportSelection(
	selected: readonly string[],
	fullName: string,
	max: number = MAX_IMPORT_SELECTION,
): ToggleResult {
	const bounded = Math.max(1, Math.trunc(max));
	if (selected.includes(fullName)) {
		return {
			selected: selected.filter((entry) => entry !== fullName),
			blocked: false,
		};
	}
	if (selected.length >= bounded) {
		return { selected: [...selected], blocked: true };
	}
	return { selected: [...selected, fullName], blocked: false };
}

/** True when the checkbox should be disabled: at the cap and not selected. */
export function isImportChoiceDisabled(
	selected: readonly string[],
	fullName: string,
	max: number = MAX_IMPORT_SELECTION,
): boolean {
	return selected.length >= max && !selected.includes(fullName);
}

/** The import action is only enabled for a non-empty, capped selection. */
export function canImport(selected: readonly string[]): boolean {
	return selected.length > 0 && selected.length <= MAX_IMPORT_SELECTION;
}

/** Keeps the selection inside the set of repositories currently offered. */
export function pruneImportSelection(
	selected: readonly string[],
	offered: readonly string[],
): string[] {
	const available = new Set(offered);
	return selected.filter((entry) => available.has(entry));
}
