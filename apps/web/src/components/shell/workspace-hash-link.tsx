import { useRouter } from "@tanstack/react-router";
import {
	type ComponentPropsWithoutRef,
	forwardRef,
	type MouseEvent,
} from "react";
import { isCurrentWorkspaceFragment } from "@/lib/workspace-scroll";
import { requestWorkspaceFragment } from "./use-workspace-scroll";

type WorkspaceHashLinkProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
	/** Fragment target id, without the leading `#`. */
	hash: string;
};

export interface WorkspaceHashLinkLocation {
	pathname: string;
	searchStr: string;
	hash: string;
}

export interface WorkspaceHashLinkNavigation {
	href: string;
	resetScroll: false;
	hashScrollIntoView: false;
}

/**
 * Decide what an in-page workspace anchor click does.
 *
 * When the router already sits on the anchor's fragment no navigation
 * happens — and therefore no `onRendered` event — so the mounted pane is
 * asked to align again instead of restoring a scrolled-away offset. The
 * comparison must use the router's normalized form (`location.hash` has no
 * leading `#`); otherwise repeated activations, including the skip link,
 * would silently fall through to a no-op navigation. When no pane answers,
 * or the location points elsewhere, a real router navigation creates the
 * history entry that Back/Forward and the coordinator rely on.
 */
export function activateWorkspaceHashLink(input: {
	hash: string;
	location: WorkspaceHashLinkLocation;
	requestFragment: (hash: string) => boolean;
	navigate: (options: WorkspaceHashLinkNavigation) => void;
}): boolean {
	const { hash, location } = input;
	if (
		isCurrentWorkspaceFragment(hash, location.hash) &&
		input.requestFragment(hash)
	) {
		return true;
	}
	input.navigate({
		href: `${location.pathname}${location.searchStr}#${hash}`,
		resetScroll: false,
		hashScrollIntoView: false,
	});
	return false;
}

/**
 * An in-page anchor that routes the fragment through the router instead of
 * the browser. The native default would scroll every scrollport (and would
 * not create a history entry the router knows about); the router navigation
 * lets the workspace scroll coordinator own the pane and keeps Back/Forward
 * pointing at real entries. Without JavaScript the plain `href="#…"` still
 * works, and the clipped shell means only the reading pane can move.
 */
export const WorkspaceHashLink = forwardRef<
	HTMLAnchorElement,
	WorkspaceHashLinkProps
>(function WorkspaceHashLink({ hash, onClick, children, ...props }, ref) {
	const router = useRouter();
	const target = `#${hash}`;

	const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
		onClick?.(event);
		if (event.defaultPrevented) return;
		if (event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		activateWorkspaceHashLink({
			hash,
			location: router.state.location,
			requestFragment: requestWorkspaceFragment,
			navigate: (options) => void router.navigate(options),
		});
	};

	return (
		<a ref={ref} href={target} onClick={handleClick} {...props}>
			{children}
		</a>
	);
});
