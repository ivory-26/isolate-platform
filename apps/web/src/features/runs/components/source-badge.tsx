import { TagIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { sourceBadge } from "../view";

const TONE_CLASS = {
	neutral: "border-line-subtle text-ink-muted",
	brand: "border-brand/30 text-brand",
	success: "border-success/30 text-success",
	warning: "border-warning/30 text-warning",
	danger: "border-danger/30 text-danger",
} as const;

/**
 * Small provenance badge for a task row. A null source is a manual submission;
 * known incident sources get readable labels. The label is always text, so the
 * badge never relies on color alone.
 */
export function RunSourceBadge({
	source,
	className,
}: {
	source: string | null;
	className?: string;
}) {
	const meta = sourceBadge(source);
	return (
		<span
			className={cn(
				"inline-flex h-4 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium",
				TONE_CLASS[meta.tone],
				className,
			)}
			data-source={source ?? "manual"}
		>
			<TagIcon size={10} />
			{meta.label}
		</span>
	);
}
