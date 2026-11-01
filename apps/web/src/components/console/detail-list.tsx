import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type DetailItem = {
	label: string;
	value: ReactNode;
	mono?: boolean;
};

/** Definition rows separated by hairlines instead of a key/value card grid. */
export function DetailList({
	items,
	className,
}: {
	items: DetailItem[];
	className?: string;
}) {
	return (
		<dl
			className={cn(
				"divide-y divide-line-subtle border-y border-line-subtle",
				className,
			)}
		>
			{items.map((item) => (
				<div
					key={item.label}
					className="grid gap-1 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-baseline sm:gap-6"
				>
					<dt className="text-xs text-ink-muted">{item.label}</dt>
					<dd
						className={cn(
							"min-w-0 break-words text-sm text-ink",
							item.mono && "font-mono text-[13px] text-ink-secondary",
						)}
					>
						{item.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
