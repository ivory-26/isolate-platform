import { useCallback, useState } from "react";

/**
 * Bounded first paint for event-driven lists.
 *
 * A run can hold `RUN_DETAIL_EVENT_LIMIT` (200) events, and the timeline and
 * log render one row each. Rendering every row on the first commit makes the
 * detail page pay for history the reader has not asked to see, so both
 * surfaces start with a small newest-first window and grow it on demand.
 */

/** Rows rendered before the reader asks for more. */
export const PROGRESSIVE_INITIAL_ROWS = 50;
/** Rows added by one "show earlier" step. */
export const PROGRESSIVE_STEP_ROWS = 50;

export type TailWindow = {
	/** Index of the first rendered row (inclusive). */
	start: number;
	/** Number of rendered rows. */
	visible: number;
	/** Rows above the window that a reveal would add. */
	hiddenBefore: number;
};

/**
 * Window over an oldest-first list, anchored at the newest row so the current
 * stage stays on screen while older stages are progressively revealed.
 * Non-finite or negative inputs collapse to an empty window instead of
 * producing a `NaN` slice.
 */
export function tailWindow(total: number, requested: number): TailWindow {
	const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
	const safeRequested =
		Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
	const visible = Math.min(safeTotal, safeRequested);
	const start = safeTotal - visible;
	return { start, visible, hiddenBefore: start };
}

/** Render-state half of `tailWindow`: the window plus its reveal control. */
export function useProgressiveTail(
	total: number,
	initial: number = PROGRESSIVE_INITIAL_ROWS,
	step: number = PROGRESSIVE_STEP_ROWS,
) {
	const [requested, setRequested] = useState(initial);
	const window = tailWindow(total, requested);
	const revealEarlier = useCallback(
		() => setRequested((current) => current + step),
		[step],
	);
	return {
		...window,
		canReveal: window.hiddenBefore > 0,
		revealEarlier,
	};
}
