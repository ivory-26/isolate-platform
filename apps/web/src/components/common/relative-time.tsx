import { useEffect, useState } from "react";
import { formatDateTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Absolute UTC time on the server and the first client render, then a relative
 * label after mount so hydration never disagrees about "now".
 */
export function RelativeTime({
	value,
	className,
}: {
	value: string;
	className?: string;
}) {
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	return (
		<time
			dateTime={value}
			title={formatDateTime(value)}
			className={cn("tabular-nums", className)}
		>
			{mounted ? relativeTime(value) : formatDateTime(value)}
		</time>
	);
}
