"use client";

import { useCallback, useMemo } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Pagination primitives shared by console tables.
 *
 * The arithmetic lives in pure helpers (`getPageCount`, `clampPage`,
 * `paginateItems`) so it can be tested without a DOM; `useClientPagination`
 * only memoises that arithmetic for a page that keeps its page number in the
 * URL, and `Pagination` renders the accessible controls.
 */

export type PageSlice<T> = {
	/** Items that belong to the clamped page. */
	pageItems: T[];
	/** Clamped page number, always within `1..pageCount`. */
	page: number;
	/** Total pages; at least one so an empty list still has a page. */
	pageCount: number;
	/** Zero-based index of the first item on the page. */
	start: number;
};

/** Total pages for `itemCount` items at `pageSize` per page. */
export function getPageCount(itemCount: number, pageSize: number): number {
	const size = Math.max(1, Math.trunc(pageSize));
	const count = Number.isFinite(itemCount)
		? Math.max(0, Math.trunc(itemCount))
		: 0;
	return Math.max(1, Math.ceil(count / size));
}

/** Clamp any page number into `1..pageCount`; a non-finite page becomes one. */
export function clampPage(page: number, pageCount: number): number {
	const count = Math.max(1, Math.trunc(pageCount));
	const candidate = Number.isFinite(page) ? Math.trunc(page) : 1;
	return Math.min(Math.max(candidate, 1), count);
}

/** Slice `items` for one page, clamping the page rather than throwing. */
export function paginateItems<T>(
	items: readonly T[],
	pageSize: number,
	page: number,
): PageSlice<T> {
	const pageCount = getPageCount(items.length, pageSize);
	const current = clampPage(page, pageCount);
	const size = Math.max(1, Math.trunc(pageSize));
	const start = (current - 1) * size;
	return {
		pageItems: items.slice(start, start + size),
		page: current,
		pageCount,
		start,
	};
}

export type UseClientPaginationOptions<T> = {
	items: readonly T[];
	pageSize: number;
	/** Page requested by the caller (usually a URL search param). */
	page: number;
	/** Called with the clamped target page; the caller owns navigation. */
	onPageChange: (page: number) => void;
};

export type ClientPagination<T> = PageSlice<T> & {
	canPrevious: boolean;
	canNext: boolean;
	goTo: (page: number) => void;
	previous: () => void;
	next: () => void;
};

/** Client-side pagination for an already-loaded list. */
export function useClientPagination<T>({
	items,
	pageSize,
	page,
	onPageChange,
}: UseClientPaginationOptions<T>): ClientPagination<T> {
	const slice = useMemo(
		() => paginateItems(items, pageSize, page),
		[items, pageSize, page],
	);
	const { page: current, pageCount } = slice;

	const goTo = useCallback(
		(nextPage: number) => {
			const target = clampPage(nextPage, pageCount);
			if (target !== current) onPageChange(target);
		},
		[current, pageCount, onPageChange],
	);
	const previous = useCallback(() => goTo(current - 1), [current, goTo]);
	const next = useCallback(() => goTo(current + 1), [current, goTo]);

	return {
		...slice,
		canPrevious: current > 1,
		canNext: current < pageCount,
		goTo,
		previous,
		next,
	};
}

export type PaginationProps = {
	page: number;
	pageCount: number;
	onPageChange: (page: number) => void;
	/** Accessible name for the nav landmark. */
	label?: string;
	className?: string;
};

/**
 * Compact console pagination: previous/next plus a fixed-width page indicator.
 * Both controls always render so the footer never changes height.
 */
export function Pagination({
	page,
	pageCount,
	onPageChange,
	label = "Pagination",
	className,
}: PaginationProps) {
	const total = Math.max(1, Math.trunc(pageCount));
	const current = clampPage(page, total);

	const goTo = (target: number) => {
		const nextPage = clampPage(target, total);
		if (nextPage !== current) onPageChange(nextPage);
	};

	return (
		<nav
			aria-label={label}
			className={cn("flex items-center justify-end gap-2 py-1", className)}
		>
			<Button
				type="button"
				variant="ghost"
				size="xs"
				disabled={current <= 1}
				aria-label="Previous page"
				onClick={() => goTo(current - 1)}
			>
				<ChevronLeftIcon />
				Previous
			</Button>
			<span
				aria-live="polite"
				className="min-w-20 text-center text-[11px] tabular-nums text-ink-muted"
			>
				Page {current} of {total}
			</span>
			<Button
				type="button"
				variant="ghost"
				size="xs"
				disabled={current >= total}
				aria-label="Next page"
				onClick={() => goTo(current + 1)}
			>
				Next
				<ChevronRightIcon />
			</Button>
		</nav>
	);
}
