import { cn } from "@/lib/utils";

type Tone = "success" | "brand" | "orange" | "warning" | "danger" | "muted";

type StatusMeta = {
	label: string;
	tone: Tone;
};

const STATUS: Record<string, StatusMeta> = {
	// Approvals
	pending: { label: "Pending", tone: "orange" },
	approved: { label: "Approved", tone: "success" },
	rejected: { label: "Rejected", tone: "danger" },
	expired: { label: "Expired", tone: "muted" },
	// Tasks and runs
	queued: { label: "Queued", tone: "muted" },
	planning: { label: "Planning", tone: "brand" },
	executing: { label: "Executing", tone: "brand" },
	validating: { label: "Validating", tone: "warning" },
	repairing: { label: "Repairing", tone: "warning" },
	awaiting_approval: { label: "Awaiting approval", tone: "orange" },
	review_ready: { label: "Review ready", tone: "success" },
	pull_request_created: { label: "PR created", tone: "brand" },
	completed: { label: "Completed", tone: "success" },
	succeeded: { label: "Succeeded", tone: "success" },
	failed: { label: "Failed", tone: "danger" },
	cancelled: { label: "Cancelled", tone: "muted" },
	blocked: { label: "Blocked", tone: "danger" },
	running: { label: "Running", tone: "brand" },
	suspended: { label: "Suspended", tone: "orange" },
	// Devices and connectors
	active: { label: "Active", tone: "success" },
	offline: { label: "Offline", tone: "muted" },
	revoked: { label: "Revoked", tone: "muted" },
	connected: { label: "Connected", tone: "success" },
	claimed: { label: "Claimed", tone: "brand" },
	invalid: { label: "Invalid", tone: "danger" },
	pending_validation: { label: "Pending validation", tone: "warning" },
	// Workflow validation
	draft: { label: "Draft", tone: "orange" },
	validated: { label: "Validated", tone: "success" },
	not_compiled: { label: "Not compiled", tone: "muted" },
};

const DOT: Record<Tone, string> = {
	success: "bg-success",
	brand: "bg-brand",
	orange: "bg-orange",
	warning: "bg-warning",
	danger: "bg-danger",
	muted: "bg-ink-muted",
};

/**
 * Status is a dot plus a written label. The dot may carry meaning but the
 * label always states it, so colour is never the only signal.
 */
export function StatusMark({
	status,
	label,
	className,
}: {
	status: string;
	label?: string;
	className?: string;
}) {
	const meta = STATUS[status] ?? {
		label: status.replaceAll("_", " "),
		tone: "muted" as const,
	};
	return (
		<span
			data-status={status}
			className={cn(
				"inline-flex items-center gap-2 text-xs text-ink-secondary",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 shrink-0 rounded-full", DOT[meta.tone])}
			/>
			<span className="truncate">{label ?? meta.label}</span>
		</span>
	);
}
