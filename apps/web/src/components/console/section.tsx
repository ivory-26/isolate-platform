import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A full-width console section: heading, optional description and action,
 * then content. No border, fill or radius — the rows inside carry the
 * structure with hairlines.
 */
export function ConsoleSection({
	id,
	title,
	description,
	action,
	children,
	className,
	contentClassName,
}: {
	id: string;
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
}) {
	return (
		<section aria-labelledby={id} className={cn("space-y-3", className)}>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
				<div className="min-w-0 space-y-1">
					<h2 id={id} className="text-sm font-medium tracking-tight text-ink">
						{title}
					</h2>
					{description ? (
						<p className="max-w-3xl text-xs leading-5 text-ink-muted">
							{description}
						</p>
					) : null}
				</div>
				{action ? (
					<div className="flex shrink-0 flex-wrap items-center gap-2">
						{action}
					</div>
				) : null}
			</div>
			<div className={contentClassName}>{children}</div>
		</section>
	);
}
