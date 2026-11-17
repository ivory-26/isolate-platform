import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useSession } from "@/components/auth/SessionProvider";
import { CodeBlock } from "@/components/common/code-block";
import { CopyButton } from "@/components/common/copy-button";
import { ErrorState } from "@/components/common/error-state";
import { KeyValue } from "@/components/common/key-value";
import { Metric, MetricStrip } from "@/components/common/metric";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { RelativeTime } from "@/components/common/relative-time";
import { Section } from "@/components/common/section";
import { StatusBadge } from "@/components/common/status-badge";
import {
	BranchIcon,
	ExternalIcon,
	LogsIcon,
	RetryIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { activeRole, requireSession } from "@/features/auth/guard";
import { authStateOptions } from "@/features/auth/queries";
import { ApprovalActions } from "@/features/runs/components/approval-actions";
import { ArtifactDownloadLink } from "@/features/runs/components/artifact-download-link";
import { RetryRunButton } from "@/features/runs/components/retry-run-button";
import { RunAttempts } from "@/features/runs/components/run-attempts";
import { RunExecutionMap } from "@/features/runs/components/run-execution-map";
import { RunLogViewer } from "@/features/runs/components/run-log-viewer";
import { RunTimeline } from "@/features/runs/components/run-timeline";
import { RunValidation } from "@/features/runs/components/run-validation";
import { RunSourceBadge } from "@/features/runs/components/source-badge";
import { ToolDecisionBadge } from "@/features/runs/components/tool-decision-badge";
import type {
	RunArtifact,
	RunTaskIdentity,
	RunUsageRecord,
} from "@/features/runs/contracts";
import {
	isLiveRunStatus,
	RUN_LIVE_POLL_INTERVAL_MS,
	RUN_MAX_RETRY_DEPTH,
} from "@/features/runs/contracts";
import { runDetailOptions } from "@/features/runs/queries";
import {
	approvalActionLabel,
	autonomyLevelLabel,
	canRetryTask,
	durationBetween,
	effectiveApprovalStatus,
	formatBytes,
	formatCostUsd,
	formatTokens,
	isDecidableApproval,
	safeExternalUrl,
	stableKeys,
	sumCompletionTokens,
	sumCostUsd,
	sumPromptTokens,
} from "@/features/runs/view";
import { formatDurationMs, shortId, statusLabel } from "@/lib/format";

const SKELETON_SLOTS = ["metric-a", "metric-b", "metric-c", "metric-d"];

export const Route = createFileRoute("/_app/runs/$taskId")({
	loader: async ({ context, params }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		requireSession(state);
		return context.queryClient.ensureQueryData(runDetailOptions(params.taskId));
	},
	component: RunDetailPage,
	pendingComponent: RunDetailPending,
	errorComponent: RunDetailError,
});

function RunDetailPending() {
	return (
		<PageContainer>
			<div className="space-y-2 border-b border-line-subtle pb-6">
				<div className="h-3 w-24 rounded bg-elevated/60" />
				<div className="h-8 w-72 rounded bg-elevated/60" />
				<div className="h-4 w-96 rounded bg-elevated/40" />
			</div>
			<div className="grid gap-px overflow-hidden rounded-lg border border-line-subtle bg-line-subtle sm:grid-cols-2 lg:grid-cols-4">
				{SKELETON_SLOTS.map((slot) => (
					<div key={slot} className="h-[92px] bg-surface/60" />
				))}
			</div>
			<div className="h-[280px] rounded bg-elevated/20" />
		</PageContainer>
	);
}

function RunDetailError({ reset }: { reset: () => void }) {
	return (
		<PageContainer>
			<PageHeader
				title="Run detail"
				description="Task identity, lifecycle, tool decisions, usage, approvals and artifacts."
			/>
			<ErrorState
				title="This run could not be loaded"
				message="The run detail is unavailable right now. Retry to read it again."
				onRetry={reset}
			/>
		</PageContainer>
	);
}

function statusTone(status: string) {
	if (status === "failed" || status === "blocked") return "danger" as const;
	if (status === "awaiting_approval") return "orange" as const;
	if (
		status === "completed" ||
		status === "review_ready" ||
		status === "pull_request_created"
	) {
		return "success" as const;
	}
	if (status === "cancelled") return "muted" as const;
	return "brand" as const;
}

function RunDetailPage() {
	const { taskId } = Route.useParams();
	const query = useSuspenseQuery(runDetailOptions(taskId));
	const session = useSession();
	const readOnly = activeRole(session) === "viewer";

	if (!query.data.ok) {
		const notFound = query.data.error.code === "NOT_FOUND";
		return (
			<PageContainer>
				<PageHeader
					title={
						<span className="font-mono text-xl">{shortId(taskId, 13)}</span>
					}
					description="This task is read from the active organization only."
				/>
				<ErrorState
					title={notFound ? "Run not found" : "Run detail unavailable"}
					message={
						notFound
							? "This run does not exist in the active organization, or you no longer have access to it."
							: query.data.error.message
					}
					onRetry={notFound ? undefined : () => void query.refetch()}
					action={
						<Button asChild variant="outline" size="sm" className="mt-1">
							<Link to="/runs">Back to runs</Link>
						</Button>
					}
				/>
			</PageContainer>
		);
	}

	const detail = query.data.value;
	const { task } = detail;
	// A live run polls itself, so an in-flight background read must not look
	// like a manual refresh (or disable the button every five seconds).
	const live = isLiveRunStatus(task.status);
	const pollSeconds = Math.round(RUN_LIVE_POLL_INTERVAL_MS / 1000);
	const pullRequestUrl = safeExternalUrl(task.pullRequestUrl);
	const latestRun = detail.workflowRuns.at(-1) ?? null;
	const pendingApprovals = detail.approvals.filter((approval) =>
		isDecidableApproval(approval),
	).length;
	const acceptanceKeys = stableKeys(
		task.acceptanceCriteria,
		(criterion) => criterion,
	);
	const ownershipKeys = stableKeys(task.fileOwnership, (path) => path);
	const toolKeys = stableKeys(
		detail.toolInvocations,
		(tool) => `${tool.createdAt}-${tool.toolName}-${tool.decision}`,
	);
	const connectorKeys = stableKeys(
		detail.connectorCalls,
		(call) => `${call.createdAt}-${call.toolName}`,
	);

	return (
		<PageContainer>
			<PageHeader
				title={
					<span className="flex flex-wrap items-center gap-3">
						<span className="font-mono text-xl">{shortId(task.id, 13)}</span>
						<StatusBadge status={task.status} />
					</span>
				}
				description={
					<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<BranchIcon size={14} className="text-ink-muted" />
						<span className="font-mono text-xs text-ink-secondary">
							{task.repository.fullName}
						</span>
						<span aria-hidden="true" className="text-ink-muted">
							/
						</span>
						<span className="font-mono text-xs text-ink-secondary">
							{task.branch}
						</span>
						<span className="text-ink-muted">
							· default branch {task.repository.defaultBranch}
						</span>
					</span>
				}
				actions={
					<>
						{live ? (
							<span
								className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted"
								title={`This run is still active; the page refreshes every ${pollSeconds} seconds.`}
							>
								<span
									aria-hidden="true"
									className="size-1.5 rounded-full bg-brand"
								/>
								Live
							</span>
						) : null}
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={query.isFetching && !live}
							onClick={() => void query.refetch()}
						>
							<RetryIcon />
							{query.isFetching && !live ? "Refreshing…" : "Refresh"}
						</Button>
						{pullRequestUrl ? (
							<Button asChild variant="outline" size="sm">
								<a
									href={pullRequestUrl}
									target="_blank"
									rel="noopener noreferrer"
								>
									<ExternalIcon />
									{task.pullRequestNumber
										? `Pull request #${task.pullRequestNumber}`
										: "Pull request"}
								</a>
							</Button>
						) : null}
						{!readOnly && canRetryTask(task) ? (
							<RetryRunButton task={task} />
						) : null}
					</>
				}
			/>

			{task.retryOf !== null || task.incidentSource !== null ? (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
					{task.retryOf !== null ? (
						<>
							<span className="text-ink-muted">Retry of</span>
							<Link
								to="/runs/$taskId"
								params={{ taskId: task.retryOf }}
								className="rounded-sm font-mono text-brand underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
							>
								{shortId(task.retryOf, 12)}
							</Link>
							<span className="text-ink-muted">
								· retry depth {task.retryDepth} / {RUN_MAX_RETRY_DEPTH}
							</span>
						</>
					) : null}
					{task.incidentSource !== null ? (
						<>
							<span className="text-ink-muted">Source</span>
							<RunSourceBadge source={task.incidentSource} />
						</>
					) : null}
				</div>
			) : null}

			<MetricStrip variant="bare">
				<Metric
					label="Task status"
					value={statusLabel(task.status)}
					tone={statusTone(task.status)}
					hint="Server-reported lifecycle state"
				/>
				<Metric
					label="Latest workflow run"
					value={latestRun ? statusLabel(latestRun.status) : "Not started"}
					tone={latestRun ? statusTone(latestRun.status) : "muted"}
					hint={
						latestRun ? (
							<RelativeTime value={latestRun.startedAt} />
						) : (
							"No run row yet"
						)
					}
				/>
				<Metric
					label="Retry depth"
					value={task.retryDepth}
					suffix={`/ ${RUN_MAX_RETRY_DEPTH}`}
					tone={task.retryDepth > 0 ? "orange" : "default"}
					hint="Reruns are new tasks"
				/>
				<Metric
					label="Pending approvals"
					value={pendingApprovals}
					tone={pendingApprovals > 0 ? "orange" : "default"}
					hint="Payload-bound decisions"
				/>
			</MetricStrip>

			{query.isRefetchError ? (
				<output className="block rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
					Refresh failed. This view may be stale; retry before approving or
					retrying.
				</output>
			) : null}

			{readOnly ? (
				<div className="border-y border-line-subtle py-2 text-xs text-ink-muted">
					Your role in this organization is read-only. Approval decisions and
					reruns are unavailable.
				</div>
			) : null}

			<Section
				variant="plain"
				title="Task"
				description="Identity and provenance as stored on the task row."
			>
				<KeyValue
					items={[
						{
							label: "Task id",
							mono: true,
							value: (
								<span className="flex items-center gap-1.5">
									<span className="break-all">{task.id}</span>
									<CopyButton value={task.id} label="Copy task id" />
								</span>
							),
						},
						{
							label: "Repository",
							mono: true,
							value: task.repository.fullName,
						},
						{ label: "Branch", mono: true, value: task.branch },
						{
							label: "Status",
							value: <StatusBadge status={task.status} />,
						},
						{
							label: "Created",
							value: <RelativeTime value={task.createdAt} />,
						},
						{
							label: "Updated",
							value: <RelativeTime value={task.updatedAt} />,
						},
						...provenanceItems(task),
					]}
				/>
				<div className="mt-6 space-y-2 border-t border-line-subtle pt-5">
					<h3 className="text-xs font-medium text-ink-muted">Goal</h3>
					{task.goal.trim().length > 0 ? (
						<p className="max-w-4xl text-sm leading-6 whitespace-pre-wrap text-ink-secondary">
							{task.goal}
						</p>
					) : (
						<p className="text-sm text-ink-muted">No goal recorded.</p>
					)}
				</div>
			</Section>

			<Section
				variant="plain"
				title="Execution boundary"
				description="What the agent was asked to satisfy and which paths it may modify."
			>
				<div className="grid gap-6 lg:grid-cols-2">
					<div className="space-y-2">
						<h3 className="text-xs font-medium text-ink-muted">
							Acceptance criteria
						</h3>
						{task.acceptanceCriteria.length === 0 ? (
							<p className="text-sm text-ink-muted">
								No acceptance criteria were recorded.
							</p>
						) : (
							<ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-ink-secondary">
								{task.acceptanceCriteria.map((criterion, index) => (
									<li key={acceptanceKeys[index]}>{criterion}</li>
								))}
							</ul>
						)}
					</div>
					<div className="space-y-2">
						<h3 className="text-xs font-medium text-ink-muted">
							File ownership
						</h3>
						{task.fileOwnership.length === 0 ? (
							<p className="text-sm text-ink-muted">
								No path ownership was recorded.
							</p>
						) : (
							<ul className="flex flex-wrap gap-1.5">
								{task.fileOwnership.map((path, index) => (
									<li
										key={ownershipKeys[index]}
										className="rounded-sm border border-line-subtle bg-elevated px-2 py-0.5 font-mono text-[11px] break-all text-ink-secondary"
									>
										{path}
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			</Section>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
				<div className="min-w-0 space-y-6">
					<Section
						variant="plain"
						title="Execution map"
						description="Task → attempt → agent turn → tool, connector, validation, approval and artifact steps, built from recorded rows. A single-agent run shows one primary agent."
					>
						<RunExecutionMap detail={detail} />
					</Section>

					<Section
						variant="plain"
						title="Attempts"
						description="Durable task_attempts rows, oldest first. An open row is still running."
					>
						<RunAttempts
							attempts={detail.attempts}
							truncated={detail.attemptsTruncated}
						/>
					</Section>

					<Section
						variant="plain"
						title="Validation"
						description="Outcome fields parsed from recorded validation.finished events. The raw event below remains the source of record."
					>
						<RunValidation
							events={detail.events}
							eventsTruncated={detail.eventsTruncated}
						/>
					</Section>

					<Section
						variant="plain"
						title="Lifecycle"
						description="Durable run events in occurrence order. Event metadata is redacted before it is stored."
					>
						<RunTimeline
							events={detail.events}
							traceId={detail.traceId}
							taskId={task.id}
							eventsTotal={detail.eventsTotal}
							eventsTruncated={detail.eventsTruncated}
						/>
					</Section>

					<Section
						variant="plain"
						title="Event log"
						description="Compact, bounded view of the same event stream with copy support."
					>
						<RunLogViewer events={detail.events} />
					</Section>

					<Section
						variant="plain"
						title="Tool invocations"
						description="Policy decisions per tool call. Arguments are represented only by their sha256 digest."
					>
						{detail.toolInvocations.length === 0 ? (
							<p className="text-sm text-ink-muted">
								No tool invocations were recorded.
							</p>
						) : (
							<div className="overflow-x-auto border-y border-line-subtle">
								<Table>
									<TableHeader>
										<TableRow className="border-line-subtle hover:bg-transparent">
											<TableHead scope="col">Tool</TableHead>
											<TableHead scope="col" className="w-[180px]">
												Decision
											</TableHead>
											<TableHead scope="col" className="w-[200px]">
												Denial
											</TableHead>
											<TableHead scope="col" className="w-[90px]">
												Duration
											</TableHead>
											<TableHead scope="col" className="w-[190px]">
												Arguments sha256
											</TableHead>
											<TableHead scope="col" className="w-[140px]">
												When
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{detail.toolInvocations.map((tool, index) => (
											<TableRow
												key={toolKeys[index]}
												className="border-line-subtle"
											>
												<TableCell className="max-w-[220px] truncate font-mono text-xs text-ink-secondary">
													{tool.toolName}
												</TableCell>
												<TableCell>
													<ToolDecisionBadge decision={tool.decision} />
												</TableCell>
												<TableCell className="max-w-[200px] truncate text-xs text-ink-muted">
													{tool.denialReason ?? "—"}
												</TableCell>
												<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
													{formatDurationMs(tool.durationMs)}
												</TableCell>
												<TableCell>
													<span className="flex items-center gap-1 font-mono text-[11px] text-ink-muted">
														<span title={tool.argumentsHash}>
															{shortId(tool.argumentsHash, 12)}
														</span>
														<CopyButton
															value={tool.argumentsHash}
															label="Copy arguments digest"
														/>
													</span>
												</TableCell>
												<TableCell className="text-xs text-ink-muted">
													<RelativeTime value={tool.createdAt} />
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}
					</Section>

					<Section
						variant="plain"
						title="Connector calls"
						description="Device-side provider work. Parameters and results never leave the device; only status metadata is shown."
					>
						{detail.connectorCalls.length === 0 ? (
							<p className="text-sm text-ink-muted">
								No connector calls were recorded.
							</p>
						) : (
							<div className="overflow-x-auto border-y border-line-subtle">
								<Table>
									<TableHeader>
										<TableRow className="border-line-subtle hover:bg-transparent">
											<TableHead scope="col">Tool</TableHead>
											<TableHead scope="col" className="w-[120px]">
												Connector
											</TableHead>
											<TableHead scope="col" className="w-[120px]">
												Status
											</TableHead>
											<TableHead scope="col" className="w-[150px]">
												Error
											</TableHead>
											<TableHead scope="col" className="w-[90px]">
												Attempts
											</TableHead>
											<TableHead scope="col" className="w-[200px]">
												Traceparent
											</TableHead>
											<TableHead scope="col" className="w-[130px]">
												Created
											</TableHead>
											<TableHead scope="col" className="w-[130px]">
												Claimed
											</TableHead>
											<TableHead scope="col" className="w-[130px]">
												Completed
											</TableHead>
											<TableHead scope="col" className="w-[90px]">
												Duration
											</TableHead>
											<TableHead scope="col" className="w-[130px]">
												Expires
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{detail.connectorCalls.map((call, index) => (
											<TableRow
												key={connectorKeys[index]}
												className="border-line-subtle"
											>
												<TableCell className="max-w-[200px] truncate font-mono text-xs text-ink-secondary">
													{call.toolName}
												</TableCell>
												<TableCell className="font-mono text-xs text-ink-secondary">
													{call.connectorId}
												</TableCell>
												<TableCell>
													<StatusBadge status={call.status} />
												</TableCell>
												<TableCell className="max-w-[150px] truncate font-mono text-[11px] text-ink-muted">
													{call.errorCode ?? "—"}
												</TableCell>
												<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
													{call.attempts}
												</TableCell>
												<TableCell className="max-w-[200px]">
													{call.traceparent ? (
														<span className="flex items-center gap-1 font-mono text-[11px] text-ink-muted">
															<span
																title={call.traceparent}
																className="truncate"
															>
																{shortId(call.traceparent, 22)}
															</span>
															<CopyButton
																value={call.traceparent}
																label="Copy traceparent"
															/>
														</span>
													) : (
														<span className="text-xs text-ink-muted">—</span>
													)}
												</TableCell>
												<TableCell className="text-xs text-ink-muted">
													<RelativeTime value={call.createdAt} />
												</TableCell>
												<TableCell className="text-xs text-ink-muted">
													{call.claimedAt ? (
														<RelativeTime value={call.claimedAt} />
													) : (
														"—"
													)}
												</TableCell>
												<TableCell className="text-xs text-ink-muted">
													{call.completedAt ? (
														<RelativeTime value={call.completedAt} />
													) : (
														"—"
													)}
												</TableCell>
												<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
													{formatDurationMs(
														durationBetween(call.claimedAt, call.completedAt),
													)}
												</TableCell>
												<TableCell className="text-xs text-ink-muted">
													<RelativeTime value={call.expiresAt} />
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}
					</Section>
				</div>

				<div className="min-w-0 space-y-6">
					<Section
						variant="plain"
						title="Approvals"
						description="Every gate is bound to the exact action payload hash it authorized."
						action={
							pendingApprovals > 0 ? (
								<span className="text-[11px] text-orange">
									{pendingApprovals} pending
								</span>
							) : null
						}
					>
						{detail.approvals.length === 0 ? (
							<p className="text-sm text-ink-muted">
								No approval gates were recorded for this task.
							</p>
						) : (
							<ul className="divide-y divide-line-subtle">
								{detail.approvals.map((approval) => {
									const status = effectiveApprovalStatus(approval);
									const decidable = isDecidableApproval(approval);
									return (
										<li
											key={approval.id}
											className="space-y-2 py-3 first:pt-0 last:pb-0"
										>
											<div className="flex flex-wrap items-center gap-2">
												<StatusBadge status={status} />
												<span className="text-xs font-medium text-ink">
													{approvalActionLabel(approval.action)}
												</span>
											</div>
											<p className="flex flex-wrap items-center gap-1 font-mono text-[11px] break-all text-ink-muted">
												payload sha256:{" "}
												<span title={approval.payloadSha256}>
													{shortId(approval.payloadSha256, 20)}
												</span>
												<CopyButton
													value={approval.payloadSha256}
													label="Copy payload digest"
												/>
											</p>
											<p className="text-[11px] text-ink-muted">
												Requested by{" "}
												<span className="font-mono">
													{shortId(approval.requestedBy, 12)}
												</span>{" "}
												· <RelativeTime value={approval.createdAt} /> · expires{" "}
												<RelativeTime value={approval.expiresAt} />
											</p>
											{approval.decidedAt ? (
												<p className="text-[11px] text-ink-muted">
													Decided by{" "}
													<span className="font-mono">
														{shortId(approval.decidedBy ?? "system", 12)}
													</span>{" "}
													· <RelativeTime value={approval.decidedAt} />
												</p>
											) : null}
											{decidable && !readOnly ? (
												<ApprovalActions taskId={task.id} approval={approval} />
											) : decidable ? (
												<p className="text-[11px] text-ink-muted">
													Read-only role: no decision controls.
												</p>
											) : status === "pending" ? (
												<p className="text-[11px] text-warning">
													This approval expired; it can no longer be decided.
												</p>
											) : null}
										</li>
									);
								})}
							</ul>
						)}
						{detail.approvalsTruncated ? (
							<p className="mt-2 text-[11px] text-warning">
								Showing the {detail.approvals.length} most recent approvals;
								older gates are not included.
							</p>
						) : null}
					</Section>

					<Section
						variant="plain"
						title="Usage"
						description="Measured usage records only. A missing cost means no trusted price was available."
					>
						<UsageSection usage={detail.usage} />
					</Section>

					<Section
						variant="plain"
						title="Artifacts"
						description="Bounded previews. A stored blob payload can be downloaded by an authenticated member of this organization."
					>
						<ArtifactsSection
							artifacts={detail.artifacts}
							truncated={detail.artifactsTruncated}
						/>
					</Section>

					<Section
						variant="plain"
						title="Workflow runs"
						description="Durable workflow run rows for this task, oldest first."
					>
						{detail.workflowRuns.length === 0 ? (
							<p className="text-sm text-ink-muted">
								No workflow run has started yet.
							</p>
						) : (
							<ul className="divide-y divide-line-subtle">
								{detail.workflowRuns.map((run) => (
									<li
										key={run.id}
										className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
									>
										<div className="flex items-center gap-2">
											<StatusBadge status={run.status} />
											<span className="font-mono text-[11px] text-ink-muted">
												{shortId(run.id, 12)}
											</span>
										</div>
										<p className="text-[11px] text-ink-muted">
											<RelativeTime value={run.startedAt} />
											{run.finishedAt ? (
												<>
													{" "}
													→ <RelativeTime value={run.finishedAt} />
												</>
											) : (
												" · open"
											)}
										</p>
									</li>
								))}
							</ul>
						)}
						{detail.workflowRunsTruncated ? (
							<p className="mt-2 text-[11px] text-warning">
								Showing the first {detail.workflowRuns.length} workflow runs.
							</p>
						) : null}
					</Section>

					<Section
						variant="plain"
						title="Retries"
						description="Later tasks created from this run by the retry action; each is an independent task."
					>
						{detail.retryChildren.length === 0 ? (
							<p className="text-sm text-ink-muted">
								No retry children were recorded for this task.
							</p>
						) : (
							<ul className="divide-y divide-line-subtle">
								{detail.retryChildren.map((child) => (
									<li
										key={child.taskId}
										className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
									>
										<div className="flex items-center gap-2">
											<StatusBadge status={child.status} />
											<Link
												to="/runs/$taskId"
												params={{ taskId: child.taskId }}
												className="rounded-sm font-mono text-[11px] text-brand underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
											>
												{shortId(child.taskId, 12)}
											</Link>
										</div>
										<p className="text-[11px] text-ink-muted">
											depth {child.retryDepth} ·{" "}
											<RelativeTime value={child.createdAt} />
										</p>
									</li>
								))}
							</ul>
						)}
						{detail.retryChildrenTruncated ? (
							<p className="mt-2 text-[11px] text-warning">
								Showing the first {detail.retryChildren.length} retries.
							</p>
						) : null}
					</Section>
				</div>
			</div>
		</PageContainer>
	);
}

function provenanceItems(task: RunTaskIdentity) {
	const items = [];
	const autonomy = autonomyLevelLabel(task.autonomyLevel);
	if (autonomy !== null) {
		items.push({
			label: "Autonomy",
			value: autonomy,
		});
	}
	if (task.retryOf) {
		items.push({
			label: "Retry of",
			mono: true,
			value: (
				<Link
					to="/runs/$taskId"
					params={{ taskId: task.retryOf }}
					className="rounded-sm text-brand underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
				>
					{task.retryOf}
				</Link>
			),
		});
	}
	if (task.incidentSource) {
		items.push({
			label: "Incident source",
			mono: true,
			value: task.incidentSource,
		});
	}
	if (task.incidentFingerprint) {
		items.push({
			label: "Incident fingerprint",
			mono: true,
			value: (
				<span className="flex items-center gap-1.5">
					<span className="break-all">{task.incidentFingerprint}</span>
					<CopyButton
						value={task.incidentFingerprint}
						label="Copy incident fingerprint"
					/>
				</span>
			),
		});
	}
	return items;
}

function UsageSection({ usage }: { usage: RunUsageRecord[] }) {
	if (usage.length === 0) {
		return (
			<p className="text-sm text-ink-muted">
				No usage records were written for this task.
			</p>
		);
	}
	const prompt = sumPromptTokens(usage);
	const completion = sumCompletionTokens(usage);
	const cost = sumCostUsd(usage);
	const usageKeys = stableKeys(
		usage,
		(row) => `${row.createdAt}-${row.provider}-${row.modelId}`,
	);
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-secondary">
				<span className="tabular-nums">
					<span className="text-ink-muted">Prompt</span> {formatTokens(prompt)}
				</span>
				<span className="tabular-nums">
					<span className="text-ink-muted">Completion</span>{" "}
					{formatTokens(completion)}
				</span>
				<span className="tabular-nums">
					<span className="text-ink-muted">Cost</span> {formatCostUsd(cost)}
				</span>
			</div>
			<div className="overflow-x-auto border-y border-line-subtle">
				<Table>
					<TableHeader>
						<TableRow className="border-line-subtle hover:bg-transparent">
							<TableHead scope="col">Provider / model</TableHead>
							<TableHead scope="col" className="w-[90px]">
								Prompt
							</TableHead>
							<TableHead scope="col" className="w-[100px]">
								Completion
							</TableHead>
							<TableHead scope="col" className="w-[100px]">
								Cost
							</TableHead>
							<TableHead scope="col" className="w-[130px]">
								Recorded
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{usage.map((row, index) => (
							<TableRow key={usageKeys[index]} className="border-line-subtle">
								<TableCell className="max-w-[220px]">
									<span className="block font-mono text-xs text-ink-secondary">
										{row.provider}
									</span>
									<span className="block truncate font-mono text-[11px] text-ink-muted">
										{row.modelId}
									</span>
								</TableCell>
								<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
									{formatTokens(row.promptTokens)}
								</TableCell>
								<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
									{formatTokens(row.completionTokens)}
								</TableCell>
								<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
									{formatCostUsd(row.costUsd)}
								</TableCell>
								<TableCell className="text-xs text-ink-muted">
									<RelativeTime value={row.createdAt} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}

function ArtifactsSection({
	artifacts,
	truncated,
}: {
	artifacts: RunArtifact[];
	truncated: boolean;
}) {
	if (artifacts.length === 0) {
		return (
			<p className="text-sm text-ink-muted">
				No artifacts were stored for this task.
			</p>
		);
	}
	return (
		<>
			<ul className="space-y-4">
				{artifacts.map((artifact) => (
					<li
						key={artifact.id}
						className="space-y-2 border-b border-line-subtle pb-4 last:border-0 last:pb-0"
					>
						<div className="flex flex-wrap items-center gap-2">
							<LogsIcon size={14} className="text-ink-muted" />
							<span className="text-xs font-medium text-ink">
								{artifact.kind}
							</span>
							<span className="font-mono text-[11px] text-ink-muted">
								{artifact.contentType}
							</span>
							<span className="font-mono text-[11px] tabular-nums text-ink-muted">
								{formatBytes(artifact.byteSize)}
							</span>
							<ArtifactDownloadLink artifact={artifact} />
							<span className="ml-auto text-[11px] text-ink-muted">
								<RelativeTime value={artifact.createdAt} />
							</span>
						</div>
						<p className="flex flex-wrap items-center gap-1 font-mono text-[11px] break-all text-ink-muted">
							{artifact.isBlob ? "blob" : "ref"}: {artifact.storageRef}
							<CopyButton
								value={artifact.storageRef}
								label="Copy storage reference"
							/>
						</p>
						{artifact.contentPreview !== null ? (
							<details>
								<summary className="cursor-pointer rounded-sm text-[11px] text-ink-secondary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
									Preview{artifact.truncated ? " (truncated)" : ""}
								</summary>
								<CodeBlock
									code={artifact.contentPreview}
									label={`${artifact.kind} preview`}
									maxHeightClassName="max-h-64"
									className="mt-2"
								/>
							</details>
						) : (
							<p className="text-[11px] text-ink-muted">
								{artifact.isBlob
									? "No inline preview was stored. Use the download link above for the stored payload."
									: "No inline preview was stored for this artifact."}
							</p>
						)}
					</li>
				))}
			</ul>
			{truncated ? (
				<p className="mt-2 text-[11px] text-warning">
					Showing the {artifacts.length} most recent artifacts; older ones are
					not included.
				</p>
			) : null}
		</>
	);
}
