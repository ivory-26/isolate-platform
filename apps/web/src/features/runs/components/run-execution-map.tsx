import type { ComponentType } from "react";
import { useMemo } from "react";
import { RelativeTime } from "@/components/common/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import {
	type AppIconProps,
	ApproveIcon,
	BoltIcon,
	ConnectorsIcon,
	CpuIcon,
	LayersIcon,
	LogsIcon,
	RunsIcon,
	ShieldCheckIcon,
	TargetIcon,
	TerminalIcon,
} from "@/components/icons";
import { formatDurationMs, shortId, statusLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RunDetailView, RunToolDecision } from "../contracts";
import {
	buildExecutionMap,
	type ExecutionNode,
	type ExecutionNodeKind,
} from "../execution-map";
import { ToolDecisionBadge } from "./tool-decision-badge";

/**
 * Read-only execution tree for one run.
 *
 * The tree is derived only from recorded attempts, agent-turn events and the
 * tool/connector/validation/approval/artifact rows already shown on the page.
 * There is no multi-agent backend: when no turn carries an `agentId`, the
 * component says so and shows a single "Primary agent" group instead of
 * inventing delegated agents.
 */

const KIND_ICONS: Record<ExecutionNodeKind, ComponentType<AppIconProps>> = {
	task: RunsIcon,
	attempt: LayersIcon,
	agent: CpuIcon,
	turn: BoltIcon,
	tool: TerminalIcon,
	connector: ConnectorsIcon,
	validation: ShieldCheckIcon,
	acceptance: TargetIcon,
	approval: ApproveIcon,
	artifact: LogsIcon,
};

const TOOL_DECISIONS: ReadonlySet<string> = new Set([
	"allowed",
	"allowed_by_approval",
	"denied",
]);

function isToolDecision(value: string | null): value is RunToolDecision {
	return value !== null && TOOL_DECISIONS.has(value);
}

function nodeDurationMs(node: ExecutionNode): number | null {
	if (node.durationMs !== null) return node.durationMs;
	if (node.timestamp === null || node.finishedAt === null) return null;
	const started = Date.parse(node.timestamp);
	const finished = Date.parse(node.finishedAt);
	if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
	const duration = finished - started;
	return duration >= 0 ? duration : null;
}

function isEmptyContainer(node: ExecutionNode): boolean {
	return (
		node.children.length === 0 &&
		(node.kind === "task" ||
			node.kind === "attempt" ||
			node.kind === "agent" ||
			node.kind === "turn")
	);
}

function NodeStatusBadge({ node }: { node: ExecutionNode }) {
	if (node.status === null) return null;
	if (node.kind === "tool" && isToolDecision(node.status)) {
		return <ToolDecisionBadge decision={node.status} />;
	}
	return <StatusBadge status={node.status} label={statusLabel(node.status)} />;
}

function ExecutionTreeItem({ node }: { node: ExecutionNode }) {
	const Glyph = KIND_ICONS[node.kind];
	const duration = nodeDurationMs(node);
	return (
		<li>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
				<span
					aria-hidden="true"
					className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line-subtle bg-elevated text-ink-muted"
				>
					<Glyph size={12} />
				</span>
				<span
					className={cn(
						"text-xs font-medium text-ink",
						node.kind === "task" && "font-mono",
					)}
					title={node.label}
				>
					{node.kind === "task" ? shortId(node.label, 13) : node.label}
				</span>
				<NodeStatusBadge node={node} />
				{node.detail !== null ? (
					<span
						className="max-w-[28ch] truncate font-mono text-[11px] text-ink-muted"
						title={node.detail}
					>
						{node.detail}
					</span>
				) : null}
				{duration !== null ? (
					<span className="font-mono text-[10px] tabular-nums text-ink-muted">
						{formatDurationMs(duration)}
					</span>
				) : null}
				{node.timestamp !== null ? (
					<span className="ml-auto text-[10px] text-ink-muted">
						<RelativeTime value={node.timestamp} />
					</span>
				) : null}
			</div>
			{node.children.length > 0 ? (
				<ul className="ml-2.5 space-y-0.5 border-l border-line-subtle pl-4">
					{node.children.map((child) => (
						<ExecutionTreeItem key={child.key} node={child} />
					))}
				</ul>
			) : isEmptyContainer(node) ? (
				<p className="ml-2.5 border-l border-line-subtle py-1 pl-4 text-[11px] text-ink-muted">
					No recorded child steps
				</p>
			) : null}
		</li>
	);
}

export function RunExecutionMap({
	detail,
	className,
}: {
	detail: RunDetailView;
	className?: string;
}) {
	const map = useMemo(() => buildExecutionMap(detail), [detail]);
	const attemptsLabel = `${map.attemptCount} attempt${map.attemptCount === 1 ? "" : "s"}`;
	const turnsLabel = `${map.turnCount} agent turn${map.turnCount === 1 ? "" : "s"}`;
	const stepsLabel = `${map.stepCount} recorded step${map.stepCount === 1 ? "" : "s"}`;

	return (
		<div className={cn("space-y-3", className)}>
			<p className="text-[11px] text-ink-muted tabular-nums">
				{attemptsLabel} · {turnsLabel} · {stepsLabel}
			</p>
			{map.hasAgentId ? null : (
				<p className="border-y border-line-subtle py-2 text-[11px] text-ink-muted">
					This run recorded one agent; delegation is not recorded.
				</p>
			)}
			{map.hasAttempts ? null : (
				<p className="border-y border-line-subtle py-2 text-[11px] text-ink-muted">
					No attempt rows were recorded for this task; the steps below hang
					directly off the task.
				</p>
			)}
			<ul aria-label="Execution map" className="space-y-0.5">
				<ExecutionTreeItem node={map.root} />
			</ul>
		</div>
	);
}
