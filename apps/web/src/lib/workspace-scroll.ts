/**
 * Workspace scroll ownership.
 *
 * The workspace shell is a fixed, clipped frame. Exactly one element may
 * scroll the page: the reading pane (`<main>`). On the layouts that mount the
 * shell (`/_app` and `/organizations`), TanStack Router's own scroll handling
 * is suppressed: it owns `window` and calls `scrollIntoView` on fragment
 * targets, which walks and scrolls every scrollport — including a shell that
 * merely uses `overflow: hidden`. Public documents (`/`, `/login`, `/signup`)
 * keep the router's native window restoration, including the inline SSR
 * restoration script, because no workspace pane exists there. The helpers
 * below are the single source of truth for the shell, the pane attributes,
 * fragment alignment and per-history-entry restoration.
 */

/** Value of the pane's `data-scroll-restoration-id` marker. */
export const WORKSPACE_SCROLL_ID = "workspace-content";

/** Attribute that marks the reading pane as the workspace scroll owner. */
export const WORKSPACE_SCROLL_ATTRIBUTE = "data-scroll-restoration-id";

/** Selector form of the marker, for diagnostics and tests. */
export const WORKSPACE_SCROLL_SELECTOR = `[${WORKSPACE_SCROLL_ATTRIBUTE}="${WORKSPACE_SCROLL_ID}"]`;

/** The pane's element id, also the destination of the skip link. */
export const WORKSPACE_MAIN_ID = "main-content";

/** Session-scoped store for per-history-entry pane positions. */
export const WORKSPACE_SCROLL_STORAGE_KEY = "isolate.workspace-scroll.v1";

/** Keep the persisted history small; a session rarely needs more. */
export const WORKSPACE_SCROLL_MAX_ENTRIES = 50;

/**
 * A preserve request only describes the navigation that is already in
 * flight. If that navigation is blocked, the request expires instead of
 * leaking into an unrelated later navigation.
 */
export const WORKSPACE_SCROLL_PRESERVE_WINDOW_MS = 2_000;

/**
 * Layout route ids whose component tree mounts {@link AppShell} and therefore
 * the workspace reading pane. `_app` is the authenticated workspace layout;
 * `organizations` reuses the same shell outside it. They are matched by route
 * id (not pathname) so a public page can never be mistaken for a workspace.
 */
export const WORKSPACE_SCROLL_OWNER_ROUTE_IDS = ["/_app", "/organizations"];

export interface WorkspaceScrollRouteMatch {
	routeId: string;
}

/** True when `routeId` is an owner layout or one of its descendants. */
export function isWorkspaceScrollRouteId(routeId: string): boolean {
	return WORKSPACE_SCROLL_OWNER_ROUTE_IDS.some(
		(owner) => routeId === owner || routeId.startsWith(`${owner}/`),
	);
}

/**
 * True when the committed route matches include a layout that mounts the
 * workspace pane. TanStack Router publishes the next matches before it emits
 * `onRendered`, and the same store backs the SSR inline-restoration decision,
 * so this answers "who owns scrolling" for the page being rendered — not for
 * a path allowlist.
 */
export function workspaceScrollOwnedByMatches(
	matches: ReadonlyArray<WorkspaceScrollRouteMatch> | null | undefined,
): boolean {
	if (!matches) return false;
	return matches.some((match) => isWorkspaceScrollRouteId(match.routeId));
}

/**
 * TanStack Router options for a router whose pages may mount the workspace
 * shell.
 *
 * The pinned router-core (`1.171.39`, `scroll-restoration.js`) checks the
 * function form of `scrollRestoration` before any scrollport work: a `false`
 * result stops both window/element restoration and the `scrollIntoView` call
 * for fragments. The same predicate also gates the inline SSR restoration
 * script (`getScrollRestorationScriptForRouter`), so public routes get the
 * router's document handling on first paint while workspace routes keep
 * exclusive custom ownership. `getMatches` is read lazily because the router
 * instance does not exist yet when these options are constructed.
 */
export function workspaceScrollRouterOptions(
	getMatches: () => ReadonlyArray<WorkspaceScrollRouteMatch> | null | undefined,
) {
	return {
		scrollRestoration: () => !workspaceScrollOwnedByMatches(getMatches()),
	} as const;
}

export type WorkspaceScrollPositions = Map<string, number>;

export interface WorkspaceScrollLocation {
	href?: string;
	hash?: string;
	state?: unknown;
}

export interface WorkspaceScrollPane {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

export interface WorkspaceScrollStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * Identity of one browser history entry. The router assigns `__TSR_key` to
 * every entry it creates; `href` is only a fallback for the very first parse
 * before a key exists. Restoration is keyed by entry, not by URL, so a fresh
 * push never inherits the scroll position of the page it replaced.
 */
export function workspaceScrollKey(
	location: WorkspaceScrollLocation | null | undefined,
): string | null {
	const state = location?.state;
	if (state !== null && typeof state === "object") {
		const key = (state as { __TSR_key?: unknown }).__TSR_key;
		if (typeof key === "string" && key.length > 0) return key;
	}
	const href = location?.href;
	return typeof href === "string" && href.length > 0 ? href : null;
}

export function maxWorkspaceScrollTop(pane: WorkspaceScrollPane): number {
	if (
		!Number.isFinite(pane.scrollHeight) ||
		!Number.isFinite(pane.clientHeight)
	) {
		return 0;
	}
	return Math.max(0, Math.floor(pane.scrollHeight - pane.clientHeight));
}

export function clampWorkspaceScrollTop(top: number, max: number): number {
	if (!Number.isFinite(top)) return 0;
	const ceiling = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
	return Math.min(Math.max(0, Math.round(top)), ceiling);
}

/**
 * Scroll offset that aligns a fragment target with the top of the reading
 * pane, honoring the target's `scroll-margin-top`. Measured relative to the
 * pane so no ancestor scrollport is involved.
 */
export function workspaceFragmentScrollTop(input: {
	paneScrollTop: number;
	paneTop: number;
	targetTop: number;
	scrollMarginTop?: number;
}): number {
	const margin =
		input.scrollMarginTop !== undefined &&
		Number.isFinite(input.scrollMarginTop)
			? Math.max(0, input.scrollMarginTop)
			: 0;
	const top = input.paneScrollTop + input.targetTop - input.paneTop - margin;
	return Math.max(0, Math.round(top));
}

/**
 * Compare a fragment id with the router's location hash.
 *
 * Pinned TanStack Router normalizes `location.hash` in `parseLocation` as
 * `decodePath(hash.slice(1))`: the stored value never includes the leading
 * `#`. Callers may still pass either form (this module's plan helper accepts
 * both), so drop the prefix on both sides before comparing.
 */
export function isCurrentWorkspaceFragment(
	hash: string | null | undefined,
	locationHash: string | null | undefined,
): boolean {
	const normalize = (value: string | null | undefined) =>
		typeof value === "string" && value.startsWith("#") ? value.slice(1) : value;
	const target = normalize(hash);
	return typeof target === "string" && target !== ""
		? target === normalize(locationHash)
		: false;
}

export function parseWorkspaceScrollPositions(
	raw: string | null | undefined,
): WorkspaceScrollPositions {
	const positions: WorkspaceScrollPositions = new Map();
	if (typeof raw !== "string" || raw.length === 0) return positions;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return positions;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return positions;
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (key.length === 0) continue;
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		if (value < 0) continue;
		positions.set(key, Math.round(value));
	}
	return positions;
}

export function serializeWorkspaceScrollPositions(
	positions: WorkspaceScrollPositions,
	maxEntries = WORKSPACE_SCROLL_MAX_ENTRIES,
): string {
	const entries = Array.from(positions.entries()).slice(
		-Math.max(1, maxEntries),
	);
	return JSON.stringify(Object.fromEntries(entries));
}

/** Record a position and keep the map bounded to the newest entries. */
export function recordWorkspaceScrollPosition(
	positions: WorkspaceScrollPositions,
	key: string | null | undefined,
	top: number,
	maxEntries = WORKSPACE_SCROLL_MAX_ENTRIES,
): void {
	if (typeof key !== "string" || key.length === 0) return;
	const value = Number.isFinite(top) ? Math.max(0, Math.round(top)) : 0;
	positions.delete(key);
	positions.set(key, value);
	const limit = Math.max(1, maxEntries);
	while (positions.size > limit) {
		const oldest = positions.keys().next();
		if (oldest.done) return;
		positions.delete(oldest.value);
	}
}

export type WorkspaceScrollPlan =
	| { kind: "fragment"; hash: string }
	| { kind: "preserve" }
	| { kind: "restore"; top: number }
	| { kind: "reset" };

/**
 * Decide what happens to the pane after a route renders.
 *
 * 1. An explicit same-route search update keeps the reader where they were.
 * 2. A history entry that was left before restores its own position — this is
 *    what makes Back return to the /runs pane offset, including entries that
 *    also carry a fragment.
 * 3. A new entry with a fragment starts at the top until the pane hook can
 *    align the target; if the target never mounts, the entry stays at the top
 *    instead of inheriting the offset of the page it replaced.
 * 4. Any other new entry starts at the top.
 */
export function planWorkspaceScroll(input: {
	/** Location hash, with or without the leading `#`. */
	hash: string;
	savedTop: number | undefined;
	preserve: boolean;
}): WorkspaceScrollPlan {
	if (input.preserve) return { kind: "preserve" };
	if (
		input.savedTop !== undefined &&
		Number.isFinite(input.savedTop) &&
		input.savedTop >= 0
	) {
		return { kind: "restore", top: Math.round(input.savedTop) };
	}
	const hash = input.hash.startsWith("#") ? input.hash.slice(1) : input.hash;
	if (hash !== "") return { kind: "fragment", hash };
	return { kind: "reset" };
}

let preserveRequestedAt: number | null = null;

/** Mark the next rendered navigation as a same-route update. */
export function requestWorkspaceScrollPreservation(now = Date.now()): void {
	preserveRequestedAt = now;
}

/** Consume (and clear) a preserve request made for the current navigation. */
export function consumeWorkspaceScrollPreservation(now = Date.now()): boolean {
	const requestedAt = preserveRequestedAt;
	preserveRequestedAt = null;
	if (requestedAt === null) return false;
	const age = now - requestedAt;
	return age >= 0 && age <= WORKSPACE_SCROLL_PRESERVE_WINDOW_MS;
}

/** Test and teardown helper; never needed by the running app. */
export function clearWorkspaceScrollPreservation(): void {
	preserveRequestedAt = null;
}

/**
 * Per-entry pane scroll state. This is deliberately framework-free so the
 * restoration rules can be tested with a fake pane and storage.
 */
export class WorkspaceScrollCoordinator {
	private readonly positions: WorkspaceScrollPositions;
	private readonly now: () => number;
	private readonly maxEntries: number;
	private storage: WorkspaceScrollStorage | null;
	private current: string | null = null;
	private transitioning = false;
	private preserveNextRender = false;

	constructor(
		private readonly pane: WorkspaceScrollPane,
		options: {
			storage?: WorkspaceScrollStorage | null;
			now?: () => number;
			maxEntries?: number;
		} = {},
	) {
		this.now = options.now ?? Date.now;
		this.maxEntries = options.maxEntries ?? WORKSPACE_SCROLL_MAX_ENTRIES;
		this.storage = options.storage ?? null;
		let raw: string | null = null;
		try {
			raw = this.storage?.getItem(WORKSPACE_SCROLL_STORAGE_KEY) ?? null;
		} catch {
			raw = null;
		}
		this.positions = parseWorkspaceScrollPositions(raw);
	}

	/** The pane still shows `from`; save its offset before the route swaps. */
	beforeLoad(
		from: WorkspaceScrollLocation | null | undefined,
		to: WorkspaceScrollLocation,
	): void {
		if (from) this.save(from);
		this.current = workspaceScrollKey(to) ?? this.current;
		this.transitioning = true;
		// Bind the marker to this navigation now. A superseded or blocked
		// navigation therefore cannot hand its preserve request to a later,
		// unrelated one.
		this.preserveNextRender = consumeWorkspaceScrollPreservation(this.now());
		if (this.preserveNextRender && this.current !== null) {
			// Same-view updates keep the live offset. Recording it under the
			// destination entry also carries it across a shell remount: the
			// pending shell may unmount this pane (and this coordinator) before
			// the destination renders, but the destination's saved position
			// survives in storage for the next coordinator's `initial`.
			recordWorkspaceScrollPosition(
				this.positions,
				this.current,
				this.pane.scrollTop,
				this.maxEntries,
			);
		}
		this.persist();
	}

	/** Record the live pane offset for the current entry. */
	record(): void {
		if (this.transitioning) return;
		recordWorkspaceScrollPosition(
			this.positions,
			this.current,
			this.pane.scrollTop,
			this.maxEntries,
		);
	}

	/**
	 * Apply the plan for a rendered navigation. Returns `null` when the entry
	 * was already handled — the router can emit `onRendered` more than once
	 * for one commit, and a duplicate must not re-consume a preserve request.
	 */
	rendered(to: WorkspaceScrollLocation): WorkspaceScrollPlan | null {
		const key = workspaceScrollKey(to);
		if (!this.transitioning && key !== null && key === this.current) {
			return null;
		}
		this.transitioning = false;
		this.current = key ?? this.current;
		return this.applyPlan(to);
	}

	/** The router may have rendered before the pane subscribed. */
	initial(to: WorkspaceScrollLocation): WorkspaceScrollPlan {
		this.transitioning = false;
		this.current = workspaceScrollKey(to) ?? this.current;
		// A remount can happen mid-navigation (the pending shell replaces the
		// app shell), so a preserve request may still be waiting.
		this.preserveNextRender = consumeWorkspaceScrollPreservation(this.now());
		return this.applyPlan(to);
	}

	/** Clamp and apply an offset; returns the value the pane accepted. */
	apply(top: number): number {
		const applied = clampWorkspaceScrollTop(
			top,
			maxWorkspaceScrollTop(this.pane),
		);
		this.pane.scrollTop = applied;
		return applied;
	}

	persist(): void {
		try {
			this.storage?.setItem(
				WORKSPACE_SCROLL_STORAGE_KEY,
				serializeWorkspaceScrollPositions(this.positions, this.maxEntries),
			);
		} catch {
			/* storage unavailable; in-memory restoration still works */
		}
	}

	private save(location: WorkspaceScrollLocation): void {
		recordWorkspaceScrollPosition(
			this.positions,
			workspaceScrollKey(location),
			this.pane.scrollTop,
			this.maxEntries,
		);
	}

	private applyPlan(to: WorkspaceScrollLocation): WorkspaceScrollPlan {
		const preserve = this.preserveNextRender;
		this.preserveNextRender = false;
		const plan = planWorkspaceScroll({
			hash: to.hash ?? "",
			savedTop: this.current ? this.positions.get(this.current) : undefined,
			preserve,
		});
		if (plan.kind === "restore") this.apply(plan.top);
		else if (plan.kind === "reset") this.apply(0);
		else if (plan.kind === "fragment") {
			// A new entry must never show the offset of the page it replaced
			// while its fragment target is still mounting. Start at the top;
			// the pane hook aligns the target when it appears and leaves the
			// entry at the top when it never does.
			this.apply(0);
		} else if (plan.kind === "preserve") this.record();
		this.persist();
		return plan;
	}
}
