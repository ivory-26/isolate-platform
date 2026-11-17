import { useId } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { RunEventView } from "../contracts";
import { PROGRESSIVE_STEP_ROWS, useProgressiveTail } from "../progressive";
import {
	ACTOR_LABELS,
	formatLogTimestamp,
	stableKeys,
	summarizeEventData,
} from "../view";

/**
 * Bounded, keyboard-scrollable view of the redacted run event stream.
 *
 * This is not an unrestricted log tail: rows come from `run_events`, whose
 * metadata is credential-scanned and size-capped, and the panel never grows
 * past a fixed height. The newest rows paint first and older ones are revealed
 * on demand, so a noisy run does not commit 200 rows before the reader scrolls.
 * Severity is conveyed by the event type text (plus the timeline icon), never
 * by color alone.
 */

function logLine(event: RunEventView): string {
	const summary = summarizeEventData(event.data);
	const base = `${formatLogTimestamp(event.createdAt)}  ${event.actor.padEnd(6)}  ${event.type}`;
	return summary.length > 0 ? `${base}  ${summary}` : base;
}

export function RunLogViewer({
	events,
	className,
}: {
	events: RunEventView[];
	className?: string;
}) {
	const text = events.map(logLine).join("\n");
	const keys = stableKeys(
		events,
		(event) => `${event.createdAt}-${event.type}-${event.actor}`,
	);
	const tail = useProgressiveTail(events.length);
	const listId = useId();
	const nextStep = Math.min(tail.hiddenBefore, PROGRESSIVE_STEP_ROWS);
	return (
		<div
			className={cn(
				"overflow-hidden rounded-md border border-line-subtle",
				className,
			)}
		>
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle bg-surface/60 px-3 py-2">
				<p className="text-[11px] text-ink-muted">
					{events.length === 0
						? "No events"
						: `${tail.visible} of ${events.length} event${events.length === 1 ? "" : "s"}`}{" "}
					· redacted stream
				</p>
				{events.length > 0 ? (
					<CopyButton value={text} label="Copy log" />
				) : null}
			</div>
			{tail.hiddenBefore > 0 ? (
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-line-subtle bg-surface/40 px-3 py-2">
					<button
						type="button"
						onClick={tail.revealEarlier}
						aria-controls={listId}
						className="rounded-sm text-[11px] text-brand underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
					>
						Show {nextStep} earlier event{nextStep === 1 ? "" : "s"}
					</button>
					<span className="text-[11px] text-ink-muted">
						{tail.hiddenBefore} older not shown
					</span>
				</div>
			) : null}
			{events.length === 0 ? (
				<p className="px-3 py-4 text-xs text-ink-muted">
					No run events recorded yet.
				</p>
			) : (
				<ScrollArea
					className="h-72 bg-canvas"
					aria-label="Run event log"
					role="group"
				>
					<ol className="space-y-0.5 px-3 py-2" id={listId}>
						{events.slice(tail.start).map((event, index) => {
							const absolute = tail.start + index;
							return (
								<li
									key={keys[absolute]}
									className="flex gap-3 py-0.5 font-mono text-[11px] leading-5"
								>
									<span className="shrink-0 text-ink-muted tabular-nums">
										{formatLogTimestamp(event.createdAt)}
									</span>
									<span className="w-12 shrink-0 text-ink-muted">
										{ACTOR_LABELS[event.actor]}
									</span>
									<span className="w-44 shrink-0 truncate text-ink-secondary">
										{event.type}
									</span>
									<span className="min-w-0 flex-1 truncate text-ink-muted">
										{summarizeEventData(event.data)}
									</span>
								</li>
							);
						})}
					</ol>
				</ScrollArea>
			)}
			<p className="border-t border-line-subtle px-3 py-2 text-[11px] leading-5 text-ink-muted">
				Credentials, tool argument payloads and raw driver output are never
				recorded in this stream.
			</p>
		</div>
	);
}
