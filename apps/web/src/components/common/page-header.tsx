import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
	title,
	description,
	actions,
	children,
	className,
}: {
	/** @deprecated Headings carry their own weight; no kicker is rendered. */
	eyebrow?: string;
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col gap-5 border-b border-line-subtle pb-6 md:flex-row md:items-end md:justify-between",
				className,
			)}
		>
			<div className="min-w-0 space-y-2">
				<h1 className="text-[26px] font-medium leading-tight tracking-[-0.02em] text-ink">
					{title}
				</h1>
				{description ? (
					<p className="max-w-[70ch] text-[13px] leading-6 text-ink-secondary">
						{description}
					</p>
				) : null}
				{children}
			</div>
			{actions ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{actions}
				</div>
			) : null}
		</div>
	);
}
