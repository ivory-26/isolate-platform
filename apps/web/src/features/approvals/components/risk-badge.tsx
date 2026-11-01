import { ShieldCheckIcon, TriangleAlertIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ApprovalRisk } from "../contracts";

const TONE: Record<ApprovalRisk["level"], string> = {
	high: "border-orange/35 bg-orange/10 text-orange",
	medium: "border-warning/30 bg-warning/10 text-warning",
	low: "border-success/30 bg-success/10 text-success",
	unknown: "border-line text-ink-secondary bg-elevated",
};

/** Impact classification with an icon and text, never color alone. */
export function ApprovalRiskBadge({
	risk,
	className,
}: {
	risk: ApprovalRisk;
	className?: string;
}) {
	const Glyph = risk.level === "low" ? ShieldCheckIcon : TriangleAlertIcon;
	return (
		<Badge
			variant="outline"
			className={cn(
				"h-6 gap-1.5 rounded-full px-2.5 text-[11px] leading-none",
				TONE[risk.level],
				className,
			)}
		>
			<Glyph size={12} />
			{risk.label}
		</Badge>
	);
}
