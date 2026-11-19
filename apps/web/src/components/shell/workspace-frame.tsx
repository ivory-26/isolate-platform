import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The workspace frame is fixed and clipped, never scrolled. `overflow: clip`
 * (not `hidden`) matters: `hidden` still makes the frame a scroll container,
 * so fragment navigation and `scrollIntoView` could shift the whole shell.
 * With `clip` the reading pane is the only element that can scroll.
 */
export const WORKSPACE_FRAME_CLASS =
	"fixed inset-0 overflow-clip bg-canvas text-ink";

export function WorkspaceFrame({
	className,
	children,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div className={cn(WORKSPACE_FRAME_CLASS, className)} {...props}>
			{children}
		</div>
	);
}
