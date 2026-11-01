import type { ComponentType } from "react";
import { RelativeTime } from "@/components/common/relative-time";
import {
	type AppIconProps,
	CheckIcon,
	ClockIcon,
	InfoIcon,
	LayersIcon,
	TriangleAlertIcon,
	WorkflowsIcon,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { WorkflowSummary, WorkflowValidationState } from "./contracts";

type StateMeta = {
	label: string;
	tone: string;
	icon: ComponentType<AppIconProps>;
	hint: string;
};

const SKELETON_ROWS = ["one", "two", "three", "four", "five"];

const STATE: Record<WorkflowValidationState, StateMeta> = {
	validated: {
		label: "Validated",
		tone: "border-success/30 bg-success/10 text-success",
		icon: CheckIcon,
		hint: "Latest version has a compiled plan.",
	},
	rejected: {
		label: "Rejected",
		tone: "border-danger/30 bg-danger/10 text-danger",
		icon: TriangleAlertIcon,
		hint: "Latest version failed compilation.",
	},
	not_compiled: {
		label: "Not compiled",
		tone: "border-line bg-elevated text-ink-secondary",
		icon: ClockIcon,
		hint: "Latest version has no compiled plan yet.",
	},
	draft: {
		label: "Draft",
		tone: "border-orange/35 bg-orange/10 text-orange",
		icon: ClockIcon,
		hint: "No immutable version exists yet.",
	},
};

function ValidationBadge({ state }: { state: WorkflowValidationState }) {
	const meta = STATE[state];
	const Glyph = meta.icon;
	return (
		<Badge
			variant="outline"
			className={`h-6 gap-1.5 rounded-full px-2.5 text-[11px] font-medium ${meta.tone}`}
			title={meta.hint}
		>
			<Glyph size={12} />
			{meta.label}
		</Badge>
	);
}

export function WorkflowsTable({
	workflows,
	truncated,
}: {
	workflows: WorkflowSummary[];
	truncated: boolean;
}) {
	return (
		<div className="space-y-2">
			<div className="overflow-x-auto rounded-lg border border-line-subtle">
				<Table>
					<caption className="sr-only">
						Workflow definitions for the active organization with their latest
						immutable version, compiled plan count, latest rejection and
						validation state.
					</caption>
					<TableHeader>
						<TableRow className="border-line-subtle hover:bg-transparent">
							<TableHead scope="col" className="min-w-[220px]">
								Definition
							</TableHead>
							<TableHead scope="col" className="w-[160px]">
								Created by
							</TableHead>
							<TableHead scope="col" className="w-[150px]">
								Versions
							</TableHead>
							<TableHead scope="col" className="w-[120px]">
								Compiled plans
							</TableHead>
							<TableHead scope="col" className="min-w-[170px]">
								Latest rejection
							</TableHead>
							<TableHead scope="col" className="w-[150px]">
								Validation
							</TableHead>
							<TableHead scope="col" className="w-[150px]">
								Created
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{workflows.map((workflow) => (
							<TableRow key={workflow.id} className="border-line-subtle">
								<TableCell className="align-top">
									<div className="flex items-center gap-2">
										<WorkflowsIcon
											size={15}
											className="shrink-0 text-ink-muted"
										/>
										<span className="truncate text-sm text-ink">
											{workflow.name}
										</span>
									</div>
									<p className="mt-0.5 font-mono text-[10px] text-ink-muted">
										{workflow.id.slice(0, 8)}…
									</p>
								</TableCell>
								<TableCell className="align-top text-xs text-ink-secondary">
									{workflow.createdBy ?? "—"}
								</TableCell>
								<TableCell className="align-top">
									{workflow.latestVersion === null ? (
										<span className="text-xs text-ink-muted">No versions</span>
									) : (
										<div className="space-y-0.5">
											<span className="font-mono text-xs text-ink">
												v{workflow.latestVersion}
											</span>
											<p className="text-[11px] text-ink-muted">
												{workflow.versionCount} total
											</p>
										</div>
									)}
								</TableCell>
								<TableCell className="align-top font-mono text-xs text-ink-secondary">
									{workflow.compiledPlanCount}
								</TableCell>
								<TableCell className="align-top">
									{workflow.latestRejection === null ? (
										<span className="text-xs text-ink-muted">
											None recorded
										</span>
									) : (
										<div className="space-y-0.5">
											<span className="flex items-center gap-1 text-xs text-ink-secondary">
												<TriangleAlertIcon size={12} className="text-orange" />
												{workflow.latestRejection.issueCount}{" "}
												{workflow.latestRejection.issueCount === 1
													? "issue"
													: "issues"}
											</span>
											<p className="text-[11px] text-ink-muted">
												on v{workflow.latestRejection.version}
											</p>
										</div>
									)}
								</TableCell>
								<TableCell className="align-top">
									<ValidationBadge state={workflow.validationState} />
								</TableCell>
								<TableCell className="align-top text-xs text-ink-secondary">
									<RelativeTime value={workflow.createdAt} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			{truncated ? (
				<p className="text-xs text-ink-muted">
					Showing the newest 100 definitions.
				</p>
			) : null}
		</div>
	);
}

export function BuilderUnavailableNote() {
	return (
		<div className="flex items-start gap-2.5 rounded-lg border border-line-subtle bg-surface/55 px-4 py-3 text-xs leading-5 text-ink-secondary">
			<LayersIcon size={15} className="mt-0.5 shrink-0 text-ink-muted" />
			<p>
				The visual workflow builder is not available in this wave. Definitions
				and immutable versions shown here are read-only; publishing happens
				outside this surface.
			</p>
		</div>
	);
}

export function WorkflowsSkeleton() {
	return (
		<div className="space-y-6">
			<div className="h-8 w-44 animate-pulse rounded-md bg-elevated" />
			<div className="flex items-start gap-2.5 rounded-lg border border-line-subtle px-4 py-3">
				<InfoIcon size={15} className="mt-0.5 text-ink-muted" />
				<Skeleton className="h-4 w-3/4" />
			</div>
			<div className="space-y-2 rounded-lg border border-line-subtle p-3">
				{SKELETON_ROWS.map((row) => (
					<Skeleton key={row} className="h-12 w-full" />
				))}
			</div>
		</div>
	);
}
