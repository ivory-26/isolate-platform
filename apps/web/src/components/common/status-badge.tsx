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

const DOT: Record<Tone, string> = {
	neutral: "bg-ink-muted",
	brand: "bg-brand",
	orange: "bg-orange",
	success: "bg-success",
	warning: "bg-warning",
	danger: "bg-danger",
	muted: "bg-ink-muted",
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
	return (
		<span
			className={cn(
				"inline-flex items-center gap-2 whitespace-nowrap text-[11px] text-ink-secondary",
				className,
			)}
			data-status={status}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 shrink-0 rounded-full", DOT[meta.tone])}
			/>
			{label ?? meta.label}
		</span>
	);
}
