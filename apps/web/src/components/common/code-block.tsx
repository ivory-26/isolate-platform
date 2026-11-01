import type { ReactNode } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { cn } from "@/lib/utils";

export function CodeBlock({
	code,
	label,
	className,
	maxHeightClassName = "max-h-96",
}: {
	code: string;
	label?: ReactNode;
	className?: string;
	maxHeightClassName?: string;
}) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-md border border-line-subtle bg-canvas",
				className,
			)}
		>
			{label ? (
				<div className="flex items-center justify-between gap-3 border-b border-line-subtle px-3 py-2">
					<span className="font-mono text-[11px] text-ink-muted">{label}</span>
					<CopyButton value={code} label="Copy code" />
				</div>
			) : null}
			<pre
				className={cn(
					"overflow-auto p-4 font-mono text-xs leading-5 text-ink-secondary",
					maxHeightClassName,
				)}
			>
				<code>{code}</code>
			</pre>
		</div>
	);
}
