import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Section({
	title,
	description,
	action,
	children,
	variant = "card",
	className,
	contentClassName,
}: {
	title?: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	variant?: "card" | "plain";
	className?: string;
	contentClassName?: string;
}) {
	const plain = variant === "plain";
	return (
		<section
			className={cn(
				plain
					? "border-t border-line-subtle"
					: "rounded-lg border border-line-subtle bg-surface/55",
				className,
			)}
		>
			{title || action ? (
				<div
					className={cn(
						"flex flex-wrap items-center justify-between gap-3",
						plain ? "py-4" : "border-b border-line-subtle px-5 py-4",
					)}
				>
					<div className="min-w-0">
						{title ? (
							<h2 className="text-sm font-medium text-ink">{title}</h2>
						) : null}
						{description ? (
							<p className="mt-1 max-w-[70ch] text-[11px] leading-5 text-ink-muted">
								{description}
							</p>
						) : null}
					</div>
					{action ? <div className="shrink-0">{action}</div> : null}
				</div>
			) : null}
			<div className={cn(plain ? "" : "p-5", contentClassName)}>{children}</div>
		</section>
	);
}
