import { describe, expect, test } from "bun:test";
import { WORKSPACE_MAIN_ID } from "@/lib/workspace-scroll";
import {
	activateWorkspaceHashLink,
	type WorkspaceHashLinkNavigation,
} from "./workspace-hash-link";

function activation(input: {
	hash: string;
	pathname?: string;
	searchStr?: string;
	locationHash: string;
	paneMounted?: boolean;
}) {
	const requested: string[] = [];
	const navigations: WorkspaceHashLinkNavigation[] = [];
	const result = activateWorkspaceHashLink({
		hash: input.hash,
		location: {
			pathname: input.pathname ?? "/runs",
			searchStr: input.searchStr ?? "",
			hash: input.locationHash,
		},
		requestFragment: (hash) => {
			requested.push(hash);
			return input.paneMounted ?? true;
		},
		navigate: (options) => {
			navigations.push(options);
		},
	});
	return { result, requested, navigations };
}

describe("activateWorkspaceHashLink", () => {
	test("a repeated skip-link activation asks the pane instead of navigating", () => {
		// The router normalizes location.hash without the leading '#'; the
		// anchor targets "#main-content". The two must still match, or the
		// second skip-link activation does nothing at all.
		const { result, requested, navigations } = activation({
			hash: WORKSPACE_MAIN_ID,
			locationHash: "main-content",
		});
		expect(result).toBe(true);
		expect(requested).toEqual(["main-content"]);
		expect(navigations).toEqual([]);
	});

	test("a repeated fragment on another path also re-activates in place", () => {
		const { result, requested, navigations } = activation({
			hash: "connect",
			pathname: "/integrations/github",
			locationHash: "#connect",
		});
		expect(result).toBe(true);
		expect(requested).toEqual(["connect"]);
		expect(navigations).toEqual([]);
	});

	test("a different fragment creates a router entry", () => {
		const { result, requested, navigations } = activation({
			hash: "connect",
			locationHash: "history",
		});
		expect(result).toBe(false);
		expect(requested).toEqual([]);
		expect(navigations).toEqual([
			{
				href: "/runs#connect",
				resetScroll: false,
				hashScrollIntoView: false,
			},
		]);
	});

	test("the destination keeps the pathname and search string", () => {
		const { navigations } = activation({
			hash: "connect",
			pathname: "/runs",
			searchStr: "?status=active&page=2",
			locationHash: "",
		});
		expect(navigations[0]?.href).toBe("/runs?status=active&page=2#connect");
	});

	test("without a mounted pane the click falls back to navigation", () => {
		const { result, requested, navigations } = activation({
			hash: WORKSPACE_MAIN_ID,
			locationHash: "main-content",
			paneMounted: false,
		});
		expect(result).toBe(false);
		expect(requested).toEqual(["main-content"]);
		expect(navigations).toHaveLength(1);
	});
});
