import { RelativeTime } from "@/components/common/relative-time";
import { ConsoleNote } from "@/components/console/note";
import { StatusMark } from "@/components/console/status-mark";
import { LayersIcon } from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { WorkflowSummary } from "./contracts";

const SKELETON_ROWS = ["one", "two", "three", "four", "five"];

export function WorkflowsTable({
	workflows,
	truncated,
}: {
	workflows: WorkflowSummary[];
	truncated: boolean;
}) {
	return (
		<div className="space-y-2">
			<div className="border-y border-line-subtle">
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
							<TableHead scope="col" className="w-[150px]">
								Created by
							</TableHead>
							<TableHead scope="col" className="w-[140px]">
								Versions
							</TableHead>
							<TableHead scope="col" className="w-[120px] text-right">
								Compiled plans
							</TableHead>
							<TableHead scope="col" className="min-w-[190px]">
								Latest rejection
							</TableHead>
							<TableHead scope="col" className="w-[150px]">
								Validation
							</TableHead>
							<TableHead scope="col" className="w-[140px]">
								Created
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{workflows.map((workflow) => (
							<TableRow key={workflow.id} className="h-11 border-line-subtle">
								<TableCell className="py-1 align-top">
									<span className="block truncate text-sm text-ink">
										{workflow.name}
									</span>
									<p className="mt-1 font-mono text-[10px] text-ink-muted">
										{workflow.id.slice(0, 8)}…
									</p>
								</TableCell>
								<TableCell className="py-1 align-top text-xs text-ink-secondary">
									{workflow.createdBy ?? "—"}
								</TableCell>
								<TableCell className="py-1 align-top">
									{workflow.latestVersion === null ? (
										<span className="text-xs text-ink-muted">—</span>
									) : (
										<div className="space-y-1">
											<span className="font-mono text-xs text-ink tabular-nums">
												v{workflow.latestVersion}
											</span>
											<p className="text-[11px] text-ink-muted tabular-nums">
												{workflow.versionCount} total
											</p>
										</div>
									)}
								</TableCell>
								<TableCell className="py-3 text-right align-top font-mono text-xs text-ink-secondary tabular-nums">
									{workflow.compiledPlanCount}
								</TableCell>
								<TableCell className="py-1 align-top">
									{workflow.latestRejection === null ? (
										<span className="text-xs text-ink-muted">
											None recorded
										</span>
									) : (
										<StatusMark
											status="rejected"
											label={`${workflow.latestRejection.issueCount} ${
												workflow.latestRejection.issueCount === 1
													? "issue"
													: "issues"
											} on v${workflow.latestRejection.version}`}
										/>
									)}
								</TableCell>
								<TableCell className="py-1 align-top">
									<StatusMark status={workflow.validationState} />
								</TableCell>
								<TableCell className="py-1 align-top text-xs text-ink-secondary">
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
		<ConsoleNote role="note" icon={LayersIcon}>
			The visual workflow builder is not available in this wave. Definitions and
			immutable versions shown here are read-only; publishing happens outside
			this surface.
		</ConsoleNote>
	);
}

export function WorkflowsSkeleton() {
	return (
		<div className="flex flex-col gap-6">
			<div className="space-y-2 border-b border-line-subtle pb-6">
				<Skeleton className="h-7 w-44" />
				<Skeleton className="h-4 w-full max-w-xl" />
			</div>
			<Skeleton className="h-9 w-full" />
			<div className="divide-y divide-line-subtle border-y border-line-subtle">
				{SKELETON_ROWS.map((row) => (
					<Skeleton key={row} className="h-12 w-full" />
				))}
			</div>
		</div>
	);
}
