import {
	CloseCircleIcon,
	ShieldCheckIcon,
	TickCircleIcon,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RunToolDecision } from "../contracts";

/** Tool policy decision: always an icon plus text, never color alone. */
const DECISION = {
	allowed: {
		label: "Allowed",
		icon: TickCircleIcon,
		className: "border-success/30 bg-success/10 text-success",
	},
	allowed_by_approval: {
		label: "Allowed by approval",
		icon: ShieldCheckIcon,
		className: "border-brand/30 bg-brand/10 text-brand",
	},
	denied: {
		label: "Denied",
		icon: CloseCircleIcon,
		className: "border-danger/30 bg-danger/10 text-danger",
	},
} as const;

export function ToolDecisionBadge({
	decision,
	className,
}: {
	decision: RunToolDecision;
	className?: string;
}) {
	const meta = DECISION[decision];
	const Glyph = meta.icon;
	return (
		<Badge
			variant="outline"
			className={cn(
				"h-6 gap-1.5 rounded-full px-2.5 text-[11px] font-medium",
				meta.className,
				className,
			)}
			data-decision={decision}
		>
			<Glyph size={12} />
			{meta.label}
		</Badge>
	);
}
