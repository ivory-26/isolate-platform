import { useRouter } from "@tanstack/react-router";
import {
	type ComponentPropsWithoutRef,
	forwardRef,
	type MouseEvent,
} from "react";
import { requestWorkspaceFragment } from "./use-workspace-scroll";

type WorkspaceHashLinkProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
	/** Fragment target id, without the leading `#`. */
	hash: string;
};

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
		const location = router.state.location;
		// The location already points at this fragment: no navigation happens,
		// so ask the pane to align again instead of restoring a scrolled-away
		// offset.
		if (location.hash === target && requestWorkspaceFragment(hash)) return;
		void router.navigate({
			href: `${location.pathname}${location.searchStr}${target}`,
			resetScroll: false,
			hashScrollIntoView: false,
		});
	};

	return (
		<a ref={ref} href={target} onClick={handleClick} {...props}>
			{children}
		</a>
	);
});
