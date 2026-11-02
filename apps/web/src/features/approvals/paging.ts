import { type PageSlice, paginateItems } from "@/components/common/pagination";
import type { ApprovalItem } from "./contracts";

/** Client-side page size for the pending and decided approval sections. */
export const APPROVALS_PAGE_SIZE = 10;

/**
 * Slices an already-loaded approval list for one page. The shared
 * `paginateItems` clamps the requested page, so a refresh that shrinks the
 * queue can never point at a page that no longer exists.
 */
export function pageApprovals(
	items: readonly ApprovalItem[],
	page: number,
): PageSlice<ApprovalItem> {
	return paginateItems(items, APPROVALS_PAGE_SIZE, page);
}
