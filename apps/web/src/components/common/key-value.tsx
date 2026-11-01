import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type KeyValueItem = {
	label: string;
	value: ReactNode;
	mono?: boolean;
};

export function KeyValue({
	items,
	className,
	columns = 2,
}: {
	items: KeyValueItem[];
	className?: string;
	columns?: 1 | 2 | 3;
}) {
	return (
		<dl
			className={cn(
				"grid gap-x-6 gap-y-4",
				columns === 1 && "grid-cols-1",
				columns === 2 && "sm:grid-cols-2",
				columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
				className,
			)}
		>
			{items.map((item) => (
				<div key={item.label} className="min-w-0 space-y-1">
					<dt className="text-xs text-ink-muted">{item.label}</dt>
					<dd
						className={cn(
							"break-words text-sm text-ink",
							item.mono && "font-mono text-[13px]",
						)}
					>
						{item.value}
					</dd>
				</div>
			))}
		</dl>
	);
}
