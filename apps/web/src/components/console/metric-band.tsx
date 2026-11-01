import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Metrics on one hairline band. No fill, radius or outer border: the numbers
 * sit directly on the page canvas.
 */
export function MetricBand({
	children,
	columns = 4,
	className,
}: {
	children: ReactNode;
	columns?: 3 | 4 | 5;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid divide-y divide-line-subtle border-y border-line-subtle",
				columns === 3 && "lg:grid-cols-3",
				columns === 4 && "lg:grid-cols-4",
				columns === 5 && "lg:grid-cols-5",
				"lg:divide-x lg:divide-y-0",
				className,
			)}
		>
			{children}
		</div>
	);
}
