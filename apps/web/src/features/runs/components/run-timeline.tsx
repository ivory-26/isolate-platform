import type { ComponentType } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { RelativeTime } from "@/components/common/relative-time";
import {
	type AppIconProps,
	ApproveIcon,
	BoltIcon,
	BranchIcon,
	ClockIcon,
	FolderOpenIcon,
	LogsIcon,
	PlayIcon,
	ScanIcon,
	ShieldCheckIcon,
	TargetIcon,
	TerminalIcon,
	VerifiedIcon,
} from "@/components/icons";
import { cn } from "@/lib/utils";
import type { RunEventView } from "../contracts";
import {
	ACTOR_LABELS,
	eventLabel,
	eventTone,
	stableKeys,
	summarizeEventData,
} from "../view";

/**
 * Lifecycle timeline for one run, built from the redacted `run_events`
 * projection. Stage-level only: event metadata is collapsed to one bounded
 * summary line and an opt-in details block, never an unbounded transcript.
 */

const TONE_CLASS = {
	neutral: "border-line text-ink-secondary",
	brand: "border-brand/40 text-brand",
	success: "border-success/40 text-success",
	warning: "border-warning/40 text-warning",
	danger: "border-danger/40 text-danger",
} as const;

const EVENT_ICONS: Record<string, ComponentType<AppIconProps>> = {
	"task.enqueued": ClockIcon,
	"task.claimed": PlayIcon,
	"task.retried": ApproveIcon,
	"workspace.cloned": FolderOpenIcon,
	"agent.turn_started": BoltIcon,
	"agent.turn_finished": VerifiedIcon,
	"tool.call": TerminalIcon,
	"tool.invoked": TerminalIcon,
	"approval.requested": ShieldCheckIcon,
	"approval.decided": ApproveIcon,
	"validation.started": ScanIcon,
	"validation.finished": ShieldCheckIcon,
	"acceptance.started": TargetIcon,
	"acceptance.finished": VerifiedIcon,
	"artifact.created": LogsIcon,
	"pr.created": BranchIcon,
};

const EVENT_DATA_MAX_CHARS = 4000;

function eventDataText(data: Record<string, unknown>): string {
	const serialized = JSON.stringify(data, null, 2) ?? "{}";
	return serialized.length > EVENT_DATA_MAX_CHARS
		? `${serialized.slice(0, EVENT_DATA_MAX_CHARS)}\n…`
		: serialized;
}

export function RunStageItem({
	event,
	last = false,
	current = false,
}: {
	event: RunEventView;
	/** Suppresses the connector line below the final stage. */
	last?: boolean;
	current?: boolean;
}) {
	const Glyph = EVENT_ICONS[event.type] ?? ClockIcon;
	const tone = eventTone(event.type);
	const summary = summarizeEventData(event.data);
	const hasData = Object.keys(event.data).length > 0;
	return (
		<li className="relative pl-9" aria-current={current ? "step" : undefined}>
			<span
				aria-hidden="true"
				className={cn(
					"absolute top-0 left-0 flex size-6 items-center justify-center rounded-full border bg-elevated",
					TONE_CLASS[tone],
				)}
			>
				<Glyph size={13} />
			</span>
			{last ? null : (
				<span
					aria-hidden="true"
					className="absolute top-7 bottom-0 left-3 w-px bg-line-subtle"
				/>
			)}
			<div className={cn("min-w-0", last ? "pb-0" : "pb-5")}>
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
					<p className="text-[13px] font-medium text-ink">
						{eventLabel(event.type)}
					</p>
					<span className="text-[10px] text-ink-muted">
						{ACTOR_LABELS[event.actor]}
					</span>
				</div>
				<p className="mt-0.5 font-mono text-[11px] text-ink-muted tabular-nums">
					<RelativeTime value={event.createdAt} />
					<span aria-hidden="true"> · </span>
					<span className="break-all">{event.type}</span>
				</p>
				{summary.length > 0 ? (
					<p className="mt-1 truncate font-mono text-[11px] text-ink-secondary">
						{summary}
					</p>
				) : null}
				{hasData ? (
					<details className="group mt-1.5">
						<summary className="cursor-pointer list-none rounded-sm text-[11px] text-ink-muted transition-colors hover:text-ink-secondary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
							<span className="group-open:hidden">Show event data</span>
							<span className="hidden group-open:inline">Hide event data</span>
						</summary>
						<pre className="mt-1.5 max-h-48 overflow-auto rounded-md border border-line-subtle bg-canvas p-3 font-mono text-[11px] leading-5 text-ink-secondary">
							{eventDataText(event.data)}
						</pre>
					</details>
				) : null}
			</div>
		</li>
	);
}

export function RunTimeline({
	events,
	traceId,
	className,
}: {
	events: RunEventView[];
	traceId: string | null;
	className?: string;
}) {
	const eventKeys = stableKeys(
		events,
		(event) => `${event.createdAt}-${event.type}-${event.actor}`,
	);
	if (events.length === 0 && traceId === null) {
		return (
			<p className="border-y border-line-subtle py-3 text-xs text-ink-muted">
				No lifecycle events recorded for this task yet. A worker writes them as
				the run advances.
			</p>
		);
	}
	return (
		<div className={cn("space-y-4", className)}>
			{traceId ? (
				<div className="flex flex-wrap items-center gap-2 border-y border-line-subtle py-2">
					<span className="text-[11px] text-ink-muted">W3C trace</span>
					<code className="font-mono text-[11px] break-all text-ink-secondary">
						{traceId}
					</code>
					<CopyButton value={traceId} label="Copy trace id" />
				</div>
			) : null}
			{events.length === 0 ? (
				<p className="border-y border-line-subtle py-3 text-xs text-ink-muted">
					No lifecycle events recorded for this task yet.
				</p>
			) : (
				<ol className="relative">
					{events.map((event, index) => (
						<RunStageItem
							key={eventKeys[index]}
							event={event}
							last={index === events.length - 1}
							current={index === events.length - 1}
						/>
					))}
				</ol>
			)}
		</div>
	);
}
