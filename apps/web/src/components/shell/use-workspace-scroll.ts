import { useRouter } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef } from "react";
import {
	maxWorkspaceScrollTop,
	WORKSPACE_MAIN_ID,
	WorkspaceScrollCoordinator,
	type WorkspaceScrollPlan,
	type WorkspaceScrollStorage,
	workspaceFragmentScrollTop,
} from "@/lib/workspace-scroll";

/**
 * How long a restore or fragment alignment may keep correcting the pane
 * while route content is still mounting. A short bound keeps the app from
 * fighting a reader who starts scrolling immediately.
 */
export const WORKSPACE_SCROLL_SETTLE_MS = 1_500;

/** Consecutive frames the pane must hold its target offset to settle. */
const SETTLE_STABLE_FRAMES = 2;

const STORAGE_PROBE_KEY = "isolate.workspace-scroll.probe";

type WorkspaceFragmentRequest = (hash: string) => void;

const fragmentRequests = new Set<WorkspaceFragmentRequest>();

/**
 * Ask the mounted workspace pane to align a fragment immediately. Used when
 * an in-page anchor is clicked while the location already points at that
 * fragment: no navigation happens, so the coordinator would otherwise keep
 * the reader's scrolled-away offset. Returns false when no pane is mounted.
 */
export function requestWorkspaceFragment(hash: string): boolean {
	if (fragmentRequests.size === 0) return false;
	for (const request of fragmentRequests) request(hash);
	return true;
}

function sessionScrollStorage(): WorkspaceScrollStorage | null {
	try {
		const storage = window.sessionStorage;
		storage.setItem(STORAGE_PROBE_KEY, "1");
		storage.removeItem(STORAGE_PROBE_KEY);
		return storage;
	} catch {
		return null;
	}
}

/**
 * Make the workspace reading pane the only scroller that survives
 * navigation.
 *
 * Returns the ref the pane must be attached to. The hook owns:
 * - per-history-entry offsets (saved on navigation and on scroll);
 * - Back/Forward restoration, including entries that carry a fragment;
 * - fragment alignment inside the pane, never `scrollIntoView` across the
 *   shell;
 * - the skip link's focus move to `#main-content`.
 */
export function useWorkspaceScrollRestoration(): RefObject<HTMLElement | null> {
	const paneRef = useRef<HTMLElement | null>(null);
	const router = useRouter();

	useEffect(() => {
		const pane = paneRef.current;
		if (pane === null) return;

		const coordinator = new WorkspaceScrollCoordinator(pane, {
			storage: sessionScrollStorage(),
		});

		let recordFrame = 0;
		let settleFrame = 0;
		let settleGeneration = 0;

		const cancelSettle = () => {
			settleGeneration += 1;
			if (settleFrame !== 0) {
				cancelAnimationFrame(settleFrame);
				settleFrame = 0;
			}
		};

		/** Re-run `step` each frame until it reports a stable result. */
		const settle = (step: () => boolean) => {
			cancelSettle();
			const generation = settleGeneration;
			const deadline = performance.now() + WORKSPACE_SCROLL_SETTLE_MS;
			let stableFrames = 0;
			const tick = () => {
				settleFrame = 0;
				if (generation !== settleGeneration) return;
				stableFrames = step() ? stableFrames + 1 : 0;
				if (
					stableFrames >= SETTLE_STABLE_FRAMES ||
					performance.now() >= deadline
				) {
					return;
				}
				settleFrame = requestAnimationFrame(tick);
			};
			settleFrame = requestAnimationFrame(tick);
		};

		/**
		 * Align a fragment target with the top of the pane. Returns true only
		 * when the target is reachable at its computed offset, so a fragment
		 * inside still-loading content is retried as the content grows.
		 */
		const alignFragment = (hash: string): boolean => {
			if (hash === WORKSPACE_MAIN_ID) {
				coordinator.apply(0);
				return true;
			}
			const target = document.getElementById(hash);
			if (target === null || !pane.contains(target)) return false;
			const margin = Number.parseFloat(
				window.getComputedStyle(target).scrollMarginTop,
			);
			const desired = workspaceFragmentScrollTop({
				paneScrollTop: pane.scrollTop,
				paneTop: pane.getBoundingClientRect().top,
				targetTop: target.getBoundingClientRect().top,
				scrollMarginTop: Number.isFinite(margin) ? margin : 0,
			});
			coordinator.apply(desired);
			return desired <= maxWorkspaceScrollTop(pane);
		};

		const handlePlan = (plan: WorkspaceScrollPlan | null) => {
			if (plan === null) return;
			cancelSettle();
			if (plan.kind === "fragment") {
				if (plan.hash === WORKSPACE_MAIN_ID) {
					pane.focus({ preventScroll: true });
				}
				settle(() => alignFragment(plan.hash));
				return;
			}
			if (plan.kind === "restore") {
				const top = plan.top;
				settle(() => {
					coordinator.apply(top);
					return maxWorkspaceScrollTop(pane) >= top;
				});
			}
		};

		const onScroll = () => {
			if (recordFrame !== 0) return;
			recordFrame = requestAnimationFrame(() => {
				recordFrame = 0;
				coordinator.record();
			});
		};

		const onPageHide = () => {
			coordinator.record();
			coordinator.persist();
		};

		const unsubscribeBeforeLoad = router.subscribe("onBeforeLoad", (event) => {
			cancelSettle();
			coordinator.beforeLoad(event.fromLocation, event.toLocation);
		});
		const unsubscribeRendered = router.subscribe("onRendered", (event) => {
			handlePlan(coordinator.rendered(event.toLocation));
		});

		const onFragmentRequest = (hash: string) => {
			handlePlan({ kind: "fragment", hash });
		};

		fragmentRequests.add(onFragmentRequest);
		pane.addEventListener("scroll", onScroll, { passive: true });
		pane.addEventListener("wheel", cancelSettle, { passive: true });
		pane.addEventListener("touchstart", cancelSettle, { passive: true });
		pane.addEventListener("pointerdown", cancelSettle);
		pane.addEventListener("keydown", cancelSettle);
		window.addEventListener("pagehide", onPageHide);

		handlePlan(coordinator.initial(router.state.location));

		return () => {
			fragmentRequests.delete(onFragmentRequest);
			unsubscribeBeforeLoad();
			unsubscribeRendered();
			window.removeEventListener("pagehide", onPageHide);
			pane.removeEventListener("scroll", onScroll);
			pane.removeEventListener("wheel", cancelSettle);
			pane.removeEventListener("touchstart", cancelSettle);
			pane.removeEventListener("pointerdown", cancelSettle);
			pane.removeEventListener("keydown", cancelSettle);
			cancelSettle();
			if (recordFrame !== 0) {
				cancelAnimationFrame(recordFrame);
				recordFrame = 0;
			}
			// Deliberately no record() here: React's development double-effect
			// would then persist the pane's pre-settle offset as the entry's
			// saved position and skip a fragment alignment on the remount.
			coordinator.persist();
		};
	}, [router]);

	return paneRef;
}
