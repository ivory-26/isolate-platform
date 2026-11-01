import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
	eyebrow,
	title,
	description,
	actions,
	children,
	className,
}: {
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
				{eyebrow ? (
					<p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted">
						{eyebrow}
					</p>
				) : null}
				<h1 className="text-2xl font-medium tracking-tight text-ink">
					{title}
				</h1>
				{description ? (
					<p className="max-w-3xl text-sm leading-6 text-ink-secondary">
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
