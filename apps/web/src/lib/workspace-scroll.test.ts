import { beforeEach, describe, expect, test } from "bun:test";
import {
	clampWorkspaceScrollTop,
	clearWorkspaceScrollPreservation,
	consumeWorkspaceScrollPreservation,
	maxWorkspaceScrollTop,
	parseWorkspaceScrollPositions,
	planWorkspaceScroll,
	recordWorkspaceScrollPosition,
	requestWorkspaceScrollPreservation,
	serializeWorkspaceScrollPositions,
	WORKSPACE_MAIN_ID,
	WORKSPACE_SCROLL_MAX_ENTRIES,
	WORKSPACE_SCROLL_PRESERVE_WINDOW_MS,
	WORKSPACE_SCROLL_ROUTER_OPTIONS,
	WORKSPACE_SCROLL_SELECTOR,
	WORKSPACE_SCROLL_STORAGE_KEY,
	WorkspaceScrollCoordinator,
	type WorkspaceScrollLocation,
	type WorkspaceScrollStorage,
	workspaceFragmentScrollTop,
	workspaceScrollKey,
} from "./workspace-scroll";

function at(href: string, key: string, hash = ""): WorkspaceScrollLocation {
	return { href, hash, state: { __TSR_key: key } };
}

function createPane(
	input: {
		scrollTop?: number;
		scrollHeight?: number;
		clientHeight?: number;
	} = {},
) {
	return {
		scrollTop: input.scrollTop ?? 0,
		scrollHeight: input.scrollHeight ?? 2_000,
		clientHeight: input.clientHeight ?? 500,
	};
}

function createStorage(): WorkspaceScrollStorage & {
	values: Map<string, string>;
} {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
}

beforeEach(() => {
	clearWorkspaceScrollPreservation();
});

describe("workspaceScrollKey", () => {
	test("prefers the history entry key", () => {
		expect(workspaceScrollKey(at("/runs", "entry-1"))).toBe("entry-1");
	});

	test("falls back to the href when no key exists yet", () => {
		expect(workspaceScrollKey({ href: "/runs" })).toBe("/runs");
		expect(workspaceScrollKey({ href: "/runs", state: {} })).toBe("/runs");
	});

	test("has no key for an empty location", () => {
		expect(workspaceScrollKey(null)).toBeNull();
		expect(workspaceScrollKey(undefined)).toBeNull();
		expect(workspaceScrollKey({})).toBeNull();
		expect(workspaceScrollKey({ state: { __TSR_key: "" } })).toBeNull();
	});
});

describe("pane math", () => {
	test("the scroll range is the content that overflows the pane", () => {
		expect(
			maxWorkspaceScrollTop({
				scrollTop: 0,
				scrollHeight: 2_000,
				clientHeight: 500,
			}),
		).toBe(1_500);
		expect(
			maxWorkspaceScrollTop({
				scrollTop: 0,
				scrollHeight: 300,
				clientHeight: 500,
			}),
		).toBe(0);
		expect(
			maxWorkspaceScrollTop({
				scrollTop: 0,
				scrollHeight: Number.NaN,
				clientHeight: 500,
			}),
		).toBe(0);
	});

	test("offsets clamp to the pane range", () => {
		expect(clampWorkspaceScrollTop(900, 1_500)).toBe(900);
		expect(clampWorkspaceScrollTop(-20, 1_500)).toBe(0);
		expect(clampWorkspaceScrollTop(9_000, 1_500)).toBe(1_500);
		expect(clampWorkspaceScrollTop(Number.NaN, 1_500)).toBe(0);
		expect(clampWorkspaceScrollTop(120.4, 1_500)).toBe(120);
	});

	test("a fragment offset is measured inside the pane, not the window", () => {
		expect(
			workspaceFragmentScrollTop({
				paneScrollTop: 100,
				paneTop: 56,
				targetTop: 456,
			}),
		).toBe(500);
	});

	test("scroll-margin-top is honored and the result never goes negative", () => {
		expect(
			workspaceFragmentScrollTop({
				paneScrollTop: 100,
				paneTop: 56,
				targetTop: 456,
				scrollMarginTop: 16,
			}),
		).toBe(484);
		expect(
			workspaceFragmentScrollTop({
				paneScrollTop: 0,
				paneTop: 56,
				targetTop: 20,
				scrollMarginTop: 0,
			}),
		).toBe(0);
	});
});

describe("position storage", () => {
	test("invalid payloads read as empty", () => {
		expect(parseWorkspaceScrollPositions(null).size).toBe(0);
		expect(parseWorkspaceScrollPositions("").size).toBe(0);
		expect(parseWorkspaceScrollPositions("not json").size).toBe(0);
		expect(parseWorkspaceScrollPositions("[]").size).toBe(0);
		expect(parseWorkspaceScrollPositions("null").size).toBe(0);
	});

	test("only finite, non-negative numbers survive", () => {
		const parsed = parseWorkspaceScrollPositions(
			JSON.stringify({ a: 120, b: -5, c: "900", d: null }),
		);
		expect(Array.from(parsed.entries())).toEqual([["a", 120]]);
	});

	test("round-trips and keeps the newest entries", () => {
		const positions = new Map<string, number>([
			["a", 1],
			["b", 2],
			["c", 3],
		]);
		expect(JSON.parse(serializeWorkspaceScrollPositions(positions, 2))).toEqual(
			{
				b: 2,
				c: 3,
			},
		);
	});

	test("recording evicts the least recently written entry", () => {
		const positions = new Map<string, number>();
		recordWorkspaceScrollPosition(positions, "a", 10, 2);
		recordWorkspaceScrollPosition(positions, "b", 20, 2);
		recordWorkspaceScrollPosition(positions, "a", 30, 2);
		recordWorkspaceScrollPosition(positions, "c", 40, 2);
		expect(Array.from(positions.entries())).toEqual([
			["a", 30],
			["c", 40],
		]);
		expect(WORKSPACE_SCROLL_MAX_ENTRIES).toBeGreaterThan(2);
	});
});

describe("planWorkspaceScroll", () => {
	test("a preserve request wins over a saved offset and a fragment", () => {
		expect(
			planWorkspaceScroll({ hash: "#connect", savedTop: 700, preserve: true }),
		).toEqual({ kind: "preserve" });
	});

	test("a saved entry offset wins over its fragment", () => {
		expect(
			planWorkspaceScroll({ hash: "#connect", savedTop: 700, preserve: false }),
		).toEqual({ kind: "restore", top: 700 });
	});

	test("a new entry with a fragment aligns it", () => {
		expect(
			planWorkspaceScroll({
				hash: "#connect",
				savedTop: undefined,
				preserve: false,
			}),
		).toEqual({ kind: "fragment", hash: "connect" });
		expect(
			planWorkspaceScroll({
				hash: "connect",
				savedTop: undefined,
				preserve: false,
			}),
		).toEqual({ kind: "fragment", hash: "connect" });
	});

	test("anything else starts at the top", () => {
		expect(
			planWorkspaceScroll({ hash: "", savedTop: undefined, preserve: false }),
		).toEqual({ kind: "reset" });
	});

	test("a corrupt saved offset falls through", () => {
		expect(
			planWorkspaceScroll({
				hash: "#verification",
				savedTop: Number.NaN,
				preserve: false,
			}),
		).toEqual({ kind: "fragment", hash: "verification" });
	});
});

describe("preserve requests", () => {
	test("a request is consumed exactly once", () => {
		requestWorkspaceScrollPreservation(1_000);
		expect(consumeWorkspaceScrollPreservation(1_000)).toBe(true);
		expect(consumeWorkspaceScrollPreservation(1_000)).toBe(false);
	});

	test("an expired request is discarded instead of leaking", () => {
		requestWorkspaceScrollPreservation(1_000);
		expect(
			consumeWorkspaceScrollPreservation(
				1_000 + WORKSPACE_SCROLL_PRESERVE_WINDOW_MS + 1,
			),
		).toBe(false);
	});
});

describe("router options", () => {
	test("the router never scrolls or restores on its own", () => {
		expect(WORKSPACE_SCROLL_ROUTER_OPTIONS.defaultHashScrollIntoView).toBe(
			false,
		);
		const scrollRestoration =
			WORKSPACE_SCROLL_ROUTER_OPTIONS.scrollRestoration as (opts: {
				location: unknown;
			}) => boolean;
		expect(scrollRestoration({ location: null })).toBe(false);
		expect("scrollToTopSelectors" in WORKSPACE_SCROLL_ROUTER_OPTIONS).toBe(
			false,
		);
	});

	test("the reading pane marker and skip-link target are stable", () => {
		expect(WORKSPACE_SCROLL_SELECTOR).toBe(
			'[data-scroll-restoration-id="workspace-content"]',
		);
		expect(WORKSPACE_MAIN_ID).toBe("main-content");
	});
});

describe("WorkspaceScrollCoordinator", () => {
	test("a new push starts at the top", () => {
		const pane = createPane({ scrollTop: 420 });
		const coordinator = new WorkspaceScrollCoordinator(pane);
		coordinator.beforeLoad(at("/runs", "runs-1"), at("/runs/run-1", "run-1"));
		expect(coordinator.rendered(at("/runs/run-1", "run-1"))).toEqual({
			kind: "reset",
		});
		expect(pane.scrollTop).toBe(0);
	});

	test("Back restores the offset the entry was left at", () => {
		const pane = createPane();
		const coordinator = new WorkspaceScrollCoordinator(pane);
		coordinator.beforeLoad(null, at("/runs", "runs-1"));
		coordinator.rendered(at("/runs", "runs-1"));
		pane.scrollTop = 900;

		coordinator.beforeLoad(at("/runs", "runs-1"), at("/runs/run-1", "run-1"));
		coordinator.rendered(at("/runs/run-1", "run-1"));
		pane.scrollTop = 120;

		coordinator.beforeLoad(at("/runs/run-1", "run-1"), at("/runs", "runs-1"));
		expect(coordinator.rendered(at("/runs", "runs-1"))).toEqual({
			kind: "restore",
			top: 900,
		});
		expect(pane.scrollTop).toBe(900);
	});

	test("Forward returns to an entry that was left at the top", () => {
		const pane = createPane();
		const coordinator = new WorkspaceScrollCoordinator(pane);
		coordinator.beforeLoad(null, at("/runs", "runs-1"));
		coordinator.rendered(at("/runs", "runs-1"));
		pane.scrollTop = 900;
		coordinator.beforeLoad(at("/runs", "runs-1"), at("/runs/run-1", "run-1"));
		coordinator.rendered(at("/runs/run-1", "run-1"));

		coordinator.beforeLoad(at("/runs/run-1", "run-1"), at("/runs", "runs-1"));
		coordinator.rendered(at("/runs", "runs-1"));
		coordinator.beforeLoad(at("/runs", "runs-1"), at("/runs/run-1", "run-1"));
		expect(coordinator.rendered(at("/runs/run-1", "run-1"))).toEqual({
			kind: "restore",
			top: 0,
		});
		expect(pane.scrollTop).toBe(0);
	});

	test("a fragment only aligns when the entry has no saved offset", () => {
		const pane = createPane();
		const coordinator = new WorkspaceScrollCoordinator(pane);
		coordinator.beforeLoad(null, at("/integrations/github", "github-1"));
		coordinator.rendered(at("/integrations/github", "github-1"));
		pane.scrollTop = 240;

		coordinator.beforeLoad(
			at("/integrations/github", "github-1"),
			at("/integrations/github#connect", "github-2", "#connect"),
		);
		expect(
			coordinator.rendered(
				at("/integrations/github#connect", "github-2", "#connect"),
			),
		).toEqual({ kind: "fragment", hash: "connect" });
		expect(pane.scrollTop).toBe(240);

		coordinator.beforeLoad(
			at("/integrations/github#connect", "github-2", "#connect"),
			at("/integrations/github", "github-1"),
		);
		expect(
			coordinator.rendered(at("/integrations/github", "github-1")),
		).toEqual({ kind: "restore", top: 240 });
	});

	test("a same-view search update keeps the offset on both directions", () => {
		const pane = createPane();
		const coordinator = new WorkspaceScrollCoordinator(pane, {
			now: () => 5_000,
		});
		coordinator.beforeLoad(null, at("/runs", "runs-1"));
		coordinator.rendered(at("/runs", "runs-1"));
		pane.scrollTop = 640;

		requestWorkspaceScrollPreservation(5_000);
		coordinator.beforeLoad(at("/runs", "runs-1"), at("/runs?page=2", "runs-2"));
		expect(coordinator.rendered(at("/runs?page=2", "runs-2"))).toEqual({
			kind: "preserve",
		});
		expect(pane.scrollTop).toBe(640);

		coordinator.beforeLoad(at("/runs?page=2", "runs-2"), at("/runs", "runs-1"));
		expect(coordinator.rendered(at("/runs", "runs-1"))).toEqual({
			kind: "restore",
			top: 640,
		});
		coordinator.beforeLoad(at("/runs", "runs-1"), at("/runs?page=2", "runs-2"));
		expect(coordinator.rendered(at("/runs?page=2", "runs-2"))).toEqual({
			kind: "restore",
			top: 640,
		});
	});

	test("a duplicate render neither re-applies nor consumes a preserve", () => {
		const pane = createPane();
		const coordinator = new WorkspaceScrollCoordinator(pane, {
			now: () => 5_000,
		});
		coordinator.beforeLoad(null, at("/runs", "runs-1"));
		coordinator.rendered(at("/runs", "runs-1"));
		pane.scrollTop = 640;

		requestWorkspaceScrollPreservation(5_000);
		coordinator.beforeLoad(at("/runs", "runs-1"), at("/runs?page=2", "runs-2"));
		expect(coordinator.rendered(at("/runs?page=2", "runs-2"))).toEqual({
			kind: "preserve",
		});
		expect(coordinator.rendered(at("/runs?page=2", "runs-2"))).toBeNull();
		expect(pane.scrollTop).toBe(640);
	});

	test("a saved offset is clamped to the content that is actually there", () => {
		const pane = createPane();
		const coordinator = new WorkspaceScrollCoordinator(pane);
		coordinator.beforeLoad(null, at("/runs", "runs-1"));
		coordinator.rendered(at("/runs", "runs-1"));
		pane.scrollTop = 900;
		coordinator.beforeLoad(at("/runs", "runs-1"), at("/runs/run-1", "run-1"));
		coordinator.rendered(at("/runs/run-1", "run-1"));

		pane.scrollHeight = 900;
		coordinator.beforeLoad(at("/runs/run-1", "run-1"), at("/runs", "runs-1"));
		expect(coordinator.rendered(at("/runs", "runs-1"))).toEqual({
			kind: "restore",
			top: 900,
		});
		expect(pane.scrollTop).toBe(400);
	});

	test("positions survive a remount through session storage", () => {
		const storage = createStorage();
		const pane = createPane();
		const coordinator = new WorkspaceScrollCoordinator(pane, { storage });
		coordinator.beforeLoad(null, at("/runs", "runs-1"));
		coordinator.rendered(at("/runs", "runs-1"));
		pane.scrollTop = 300;
		coordinator.beforeLoad(at("/runs", "runs-1"), at("/runs/run-1", "run-1"));
		coordinator.rendered(at("/runs/run-1", "run-1"));
		expect(storage.values.has(WORKSPACE_SCROLL_STORAGE_KEY)).toBe(true);

		const remountedPane = createPane();
		const remounted = new WorkspaceScrollCoordinator(remountedPane, {
			storage,
		});
		expect(remounted.initial(at("/runs", "runs-1"))).toEqual({
			kind: "restore",
			top: 300,
		});
		expect(remountedPane.scrollTop).toBe(300);
	});

	test("a failing storage never breaks restoration", () => {
		const failing: WorkspaceScrollStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		const pane = createPane();
		const coordinator = new WorkspaceScrollCoordinator(pane, {
			storage: failing,
		});
		coordinator.beforeLoad(null, at("/runs", "runs-1"));
		expect(coordinator.rendered(at("/runs", "runs-1"))).toEqual({
			kind: "reset",
		});
		expect(pane.scrollTop).toBe(0);
	});
});
