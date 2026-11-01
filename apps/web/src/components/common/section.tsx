import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Section({
	title,
	description,
	action,
	children,
	className,
	contentClassName,
}: {
	title?: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
}) {
	return (
		<section
			className={cn(
				"rounded-lg border border-line-subtle bg-surface/55",
				className,
			)}
		>
			{title || action ? (
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle px-5 py-4">
					<div className="min-w-0">
						{title ? (
							<h2 className="text-sm font-medium text-ink">{title}</h2>
						) : null}
						{description ? (
							<p className="mt-1 text-xs leading-5 text-ink-muted">
								{description}
							</p>
						) : null}
					</div>
					{action ? <div className="shrink-0">{action}</div> : null}
				</div>
			) : null}
			<div className={cn("p-5", contentClassName)}>{children}</div>
		</section>
	);
}
