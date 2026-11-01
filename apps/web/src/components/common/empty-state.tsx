import type { ComponentType, ReactNode } from "react";
import { type AppIconProps, InboxIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

export function EmptyState({
	title,
	description,
	action,
	icon: Glyph = InboxIcon,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	icon?: ComponentType<AppIconProps>;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-line px-6 py-12 text-center",
				className,
			)}
		>
			<div className="flex size-10 items-center justify-center rounded-md border border-line-subtle bg-elevated text-ink-muted">
				<Glyph size={20} />
			</div>
			<div className="space-y-1">
				<p className="text-sm font-medium text-ink">{title}</p>
				{description ? (
					<p className="mx-auto max-w-md text-sm leading-6 text-ink-muted">
						{description}
					</p>
				) : null}
			</div>
			{action}
		</div>
	);
}
