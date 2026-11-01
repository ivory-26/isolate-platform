import type { ComponentType } from "react";
import {
	type AppIconProps,
	ArrowRightIcon,
	ClockIcon,
	CloseCircleIcon,
	LockIcon,
	PauseIcon,
	PlayIcon,
	RefreshIcon,
	RouteIcon,
	ShieldCheckIcon,
	SignalIcon,
	TickCircleIcon,
	TriangleAlertIcon,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Tone =
	| "neutral"
	| "brand"
	| "orange"
	| "success"
	| "warning"
	| "danger"
	| "muted";

type Meta = {
	label: string;
	tone: Tone;
	icon: ComponentType<AppIconProps>;
};

const STATUS: Record<string, Meta> = {
	queued: { label: "Queued", tone: "neutral", icon: ClockIcon },
	planning: { label: "Planning", tone: "brand", icon: RouteIcon },
	executing: { label: "Executing", tone: "brand", icon: PlayIcon },
	validating: { label: "Validating", tone: "warning", icon: ShieldCheckIcon },
	repairing: { label: "Repairing", tone: "warning", icon: RefreshIcon },
	awaiting_approval: {
		label: "Awaiting approval",
		tone: "orange",
		icon: ShieldCheckIcon,
	},
	review_ready: {
		label: "Review ready",
		tone: "success",
		icon: TickCircleIcon,
	},
	pull_request_created: {
		label: "PR created",
		tone: "brand",
		icon: ArrowRightIcon,
	},
	completed: { label: "Completed", tone: "success", icon: TickCircleIcon },
	succeeded: { label: "Succeeded", tone: "success", icon: TickCircleIcon },
	failed: { label: "Failed", tone: "danger", icon: TriangleAlertIcon },
	cancelled: { label: "Cancelled", tone: "muted", icon: CloseCircleIcon },
	blocked: { label: "Blocked", tone: "danger", icon: LockIcon },
	running: { label: "Running", tone: "brand", icon: PlayIcon },
	suspended: { label: "Suspended", tone: "orange", icon: PauseIcon },
	pending: { label: "Pending", tone: "orange", icon: ClockIcon },
	approved: { label: "Approved", tone: "success", icon: TickCircleIcon },
	rejected: { label: "Rejected", tone: "danger", icon: CloseCircleIcon },
	expired: { label: "Expired", tone: "muted", icon: ClockIcon },
	active: { label: "Active", tone: "success", icon: SignalIcon },
	offline: { label: "Offline", tone: "muted", icon: SignalIcon },
	revoked: { label: "Revoked", tone: "muted", icon: CloseCircleIcon },
	connected: { label: "Connected", tone: "success", icon: SignalIcon },
	claimed: { label: "Claimed", tone: "brand", icon: PlayIcon },
};

const TONE: Record<Tone, string> = {
	neutral: "border-line text-ink-secondary bg-elevated",
	brand: "border-brand/30 bg-brand/10 text-brand",
	orange: "border-orange/35 bg-orange/10 text-orange",
	success: "border-success/30 bg-success/10 text-success",
	warning: "border-warning/30 bg-warning/10 text-warning",
	danger: "border-danger/30 bg-danger/10 text-danger",
	muted: "border-line-subtle bg-elevated text-ink-muted",
};

export function StatusBadge({
	status,
	className,
	label,
}: {
	status: string;
	className?: string;
	label?: string;
}) {
	const meta = STATUS[status] ?? {
		label: status.replaceAll("_", " "),
		tone: "neutral" as const,
		icon: ClockIcon,
	};
	const Glyph = meta.icon;
	return (
		<Badge
			variant="outline"
			className={cn(
				"h-6 gap-1.5 rounded-full px-2.5 font-medium text-[11px] leading-none",
				TONE[meta.tone],
				className,
			)}
			data-status={status}
		>
			<Glyph size={12} />
			{label ?? meta.label}
		</Badge>
	);
}
