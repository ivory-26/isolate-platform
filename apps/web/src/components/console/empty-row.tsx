import type { ReactNode } from "react";

/**
 * An empty state as a full-width row rather than a dashed card. The hairlines
 * keep it in the same visual rhythm as populated rows.
 */
export function EmptyRow({
	title,
	description,
	action,
}: {
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-4 border-y border-line-subtle py-10 sm:flex-row sm:items-center sm:justify-between">
			<div className="min-w-0 space-y-1">
				<p className="text-sm font-medium text-ink">{title}</p>
				{description ? (
					<p className="max-w-xl text-xs leading-5 text-ink-muted">
						{description}
					</p>
				) : null}
			</div>
			{action ? <div className="shrink-0">{action}</div> : null}
		</div>
	);
}
