import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/components/auth/SessionProvider";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { ConsoleNote } from "@/components/console/note";
import { StatusMark } from "@/components/console/status-mark";
import { ArrowRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { activeRole, requireSession } from "@/features/auth/guard";
import { authStateOptions } from "@/features/auth/queries";
import type {
	RepositoryOption,
	WorkflowOption,
} from "@/features/overview/contracts";
import { submitOptionsQueryOptions } from "@/features/overview/queries";
import {
	type SubmitTaskInput,
	submitTaskSchema,
} from "@/features/tasks/contracts";
import {
	DELEGATE_DEFAULT_BUDGETS,
	DELEGATE_MESSAGES,
	type DelegateFieldValues,
	defaultManualBranch,
	defaultWorkflowSelection,
	parseDelegateSubmission,
	splitComposerLines,
	versionsFor,
} from "@/features/tasks/delegate";
import { taskKeys } from "@/features/tasks/queries";
import { submitTask } from "@/features/tasks/tasks.functions";
import { shortId } from "@/lib/format";

export const Route = createFileRoute("/_app/submit")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		return requireSession(state);
	},
	component: SubmitPage,
});

/**
 * Local demo fallbacks. The demo store has no database behind the read model,
 * so the two documented demo ids stand in for the option lists. They are
 * display-and-select only; the server still validates every submission.
 */
const DEMO_REPOSITORY: RepositoryOption = {
	id: "10000000-0000-4000-8000-000000000003",
	name: "Demo repository",
	defaultBranch: "main",
};
const DEMO_WORKFLOW: WorkflowOption = {
	id: "10000000-0000-4000-8000-000000000004",
	name: "Demo workflow",
	versions: [1],
};

function Field({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
			{hint ? <p className="text-xs leading-5 text-ink-muted">{hint}</p> : null}
		</div>
	);
}

function SubmitPage() {
	const queryClient = useQueryClient();
	const request = useRef<SubmitTaskInput | null>(null);
	const idempotencyKey = useRef<string | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);
	const session = useSession();
	const readOnly = activeRole(session) === "viewer";

	const optionsQuery = useQuery(submitOptionsQueryOptions());
	const options = optionsQuery.data?.ok ? optionsQuery.data.value : null;
	const demo = session.mode === "demo";
	const repositories: RepositoryOption[] = useMemo(
		() =>
			options !== null && options.repositories.length > 0
				? options.repositories
				: demo
					? [DEMO_REPOSITORY]
					: [],
		[options, demo],
	);
	const workflows: WorkflowOption[] = useMemo(
		() =>
			options !== null && options.workflows.length > 0
				? options.workflows
				: demo
					? [DEMO_WORKFLOW]
					: [],
		[options, demo],
	);
	const optionsUnavailable =
		optionsQuery.isError ||
		(optionsQuery.data !== undefined && !optionsQuery.data.ok);

	const [repositoryId, setRepositoryId] = useState("");
	const [goal, setGoal] = useState("");
	const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
	const [fileOwnership, setFileOwnership] = useState("");
	const [branch, setBranch] = useState("");
	const [generatedBranch, setGeneratedBranch] = useState("");
	const [definitionId, setDefinitionId] = useState("");
	const [version, setVersion] = useState<number | null>(null);
	const [maxAgentTurns, setMaxAgentTurns] = useState<number>(
		DELEGATE_DEFAULT_BUDGETS.maxAgentTurns,
	);
	const [repairBudget, setRepairBudget] = useState<number>(
		DELEGATE_DEFAULT_BUDGETS.repairBudget,
	);
	const [jobTimeoutMs, setJobTimeoutMs] = useState<number>(
		DELEGATE_DEFAULT_BUDGETS.jobTimeoutMs,
	);

	// Defaults are resolved on the client so server and hydration agree.
	useEffect(() => {
		setGeneratedBranch(defaultManualBranch(crypto.randomUUID()));
	}, []);

	useEffect(() => {
		if (repositoryId === "" && repositories[0] !== undefined) {
			setRepositoryId(repositories[0].id);
		}
	}, [repositoryId, repositories]);

	useEffect(() => {
		if (definitionId !== "") return;
		const selection = defaultWorkflowSelection(workflows);
		if (selection === null) return;
		setDefinitionId(selection.workflowDefinitionId);
		setVersion(selection.workflowVersion);
	}, [definitionId, workflows]);

	const versions = versionsFor(workflows, definitionId);
	const blockedReason =
		repositories.length === 0
			? DELEGATE_MESSAGES.noRepository
			: definitionId === "" || version === null
				? DELEGATE_MESSAGES.noPublishedWorkflow
				: null;

	const mutation = useMutation({
		mutationFn: (data: SubmitTaskInput) => submitTask({ data }),
		onSuccess: async (result) => {
			if (result.ok) {
				await queryClient.invalidateQueries({ queryKey: taskKeys.all });
			}
		},
	});
	const locked = mutation.isPending || request.current !== null || readOnly;
	const formDisabled = locked || blockedReason !== null;

	const buildValues = (): DelegateFieldValues => ({
		repositoryId,
		goal,
		acceptanceCriteria: splitComposerLines(acceptanceCriteria),
		fileOwnership: splitComposerLines(fileOwnership),
		branch:
			branch.trim() ||
			generatedBranch ||
			defaultManualBranch(crypto.randomUUID()),
		workflowDefinitionId: definitionId,
		workflowVersion: version ?? 1,
		maxAgentTurns,
		repairBudget,
		jobTimeoutMs,
	});

	const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (mutation.isPending || (mutation.isSuccess && mutation.data.ok)) return;
		if (blockedReason !== null) {
			setValidationError(blockedReason);
			return;
		}
		// A retry reuses the exact validated request, so the same idempotency
		// key reaches the server and a replay cannot create a second task.
		if (request.current !== null) {
			const replay = submitTaskSchema.safeParse(request.current);
			if (replay.success) {
				mutation.mutate(replay.data);
				return;
			}
		}
		idempotencyKey.current ??= crypto.randomUUID();
		const parsed = parseDelegateSubmission(
			buildValues(),
			idempotencyKey.current,
		);
		if (!parsed.ok) {
			setValidationError(parsed.message);
			return;
		}
		setValidationError(null);
		request.current = parsed.value;
		mutation.mutate(parsed.value);
	};

	return (
		<PageContainer>
			<PageHeader
				title="Delegate a task"
				description="Hand one bounded engineering task to an agent. Connected sources normally create tasks without this form; use it when you want to start work yourself."
			/>
			{readOnly ? (
				<ConsoleNote role="alert" tone="warning">
					Your role in this organization is read-only. Ask an owner or admin for
					submit access.
				</ConsoleNote>
			) : null}
			{demo ? (
				<ConsoleNote role="note">
					Local demo: data is temporary and no worker executes it. The demo
					repository and workflow version are the only selectable options.
				</ConsoleNote>
			) : null}

			<form className="space-y-6" onSubmit={onSubmit}>
				<fieldset disabled={formDisabled} className="space-y-6">
					<div className="grid gap-4 md:grid-cols-2">
						<Field
							label="Repository"
							htmlFor="repositoryId"
							hint="Imported repositories only. Manage the list under Repositories."
						>
							{repositories.length > 0 ? (
								<Select value={repositoryId} onValueChange={setRepositoryId}>
									<SelectTrigger id="repositoryId" className="w-full">
										<SelectValue placeholder="Select a repository" />
									</SelectTrigger>
									<SelectContent>
										{repositories.map((repository) => (
											<SelectItem key={repository.id} value={repository.id}>
												{repository.name}
												<span className="font-mono text-[11px] text-ink-muted">
													{repository.defaultBranch}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<p className="text-xs leading-5 text-ink-muted">
									No repository is imported yet.
								</p>
							)}
						</Field>
					</div>

					<Field
						label="Goal"
						htmlFor="goal"
						hint="What should the agent accomplish? The worker receives exactly this text."
					>
						<Textarea
							id="goal"
							value={goal}
							onChange={(event) => setGoal(event.target.value)}
							required
							maxLength={4000}
							rows={4}
							placeholder="Fix the failing checkout test and add a regression case."
						/>
					</Field>

					<Field
						label="Acceptance criteria"
						htmlFor="acceptanceCriteria"
						hint="Optional. One criterion per line."
					>
						<Textarea
							id="acceptanceCriteria"
							value={acceptanceCriteria}
							onChange={(event) => setAcceptanceCriteria(event.target.value)}
							rows={3}
							placeholder={
								"All tests pass\nNo files outside the ownership list change"
							}
						/>
					</Field>

					<details className="group border-t border-line-subtle pt-4">
						<summary className="cursor-pointer list-none text-xs font-medium text-ink-secondary hover:text-ink">
							Advanced
							<span className="ml-2 text-[11px] font-normal text-ink-muted">
								Branch, workflow, ownership and limits
							</span>
						</summary>
						<div className="mt-4 space-y-6">
							<div className="grid gap-4 md:grid-cols-2">
								<Field
									label="Task branch"
									htmlFor="branch"
									hint={`Default: ${generatedBranch || "task/manual-<short id>"}. The worker commits only to this branch.`}
								>
									<Input
										id="branch"
										value={branch}
										onChange={(event) => setBranch(event.target.value)}
										maxLength={120}
										placeholder={generatedBranch || "task/manual-<short id>"}
										autoComplete="off"
										spellCheck={false}
									/>
								</Field>
								<Field
									label="Workflow"
									htmlFor="workflowDefinitionId"
									hint="Defaults to the first published workflow version."
								>
									<Select
										value={definitionId}
										onValueChange={(nextId) => {
											setDefinitionId(nextId);
											setVersion(versionsFor(workflows, nextId)[0] ?? null);
										}}
									>
										<SelectTrigger id="workflowDefinitionId" className="w-full">
											<SelectValue placeholder="Select a workflow" />
										</SelectTrigger>
										<SelectContent>
											{workflows.map((workflow) => (
												<SelectItem
													key={workflow.id}
													value={workflow.id}
													disabled={workflow.versions.length === 0}
												>
													{workflow.name}
													<span className="font-mono text-[11px] text-ink-muted">
														{workflow.versions.length === 0
															? "no published version"
															: `v${workflow.versions[0]}`}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
								<Field
									label="Pinned workflow version"
									htmlFor="workflowVersion"
								>
									{versions.length > 0 && version !== null ? (
										<Select
											value={String(version)}
											onValueChange={(next) => setVersion(Number(next))}
										>
											<SelectTrigger id="workflowVersion" className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{versions.map((entry) => (
													<SelectItem key={entry} value={String(entry)}>
														Version {entry}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									) : (
										<p className="text-xs text-ink-muted">
											Publish a workflow version first.
										</p>
									)}
								</Field>
								<Field
									label="File ownership"
									htmlFor="fileOwnership"
									hint="One path or glob per line. Everything else stays out of bounds."
								>
									<Textarea
										id="fileOwnership"
										value={fileOwnership}
										onChange={(event) => setFileOwnership(event.target.value)}
										rows={3}
										placeholder={"apps/web/**\npackages/shared/**"}
									/>
								</Field>
							</div>

							<div className="grid gap-4 md:grid-cols-3">
								<Field label="Maximum agent turns" htmlFor="maxAgentTurns">
									<Input
										id="maxAgentTurns"
										type="number"
										min={1}
										max={50}
										value={maxAgentTurns}
										onChange={(event) =>
											setMaxAgentTurns(Number(event.target.value))
										}
										required
									/>
								</Field>
								<Field label="Maximum repair attempts" htmlFor="repairBudget">
									<Input
										id="repairBudget"
										type="number"
										min={0}
										max={5}
										value={repairBudget}
										onChange={(event) =>
											setRepairBudget(Number(event.target.value))
										}
										required
									/>
								</Field>
								<Field
									label="Duration budget (ms)"
									htmlFor="jobTimeoutMs"
									hint="1,000 to 3,600,000."
								>
									<Input
										id="jobTimeoutMs"
										type="number"
										min={1000}
										max={3600000}
										value={jobTimeoutMs}
										onChange={(event) =>
											setJobTimeoutMs(Number(event.target.value))
										}
										required
									/>
								</Field>
							</div>
						</div>
					</details>
				</fieldset>

				{blockedReason !== null ? (
					<ConsoleNote role="note" tone="warning">
						{blockedReason}
						{repositories.length === 0 ? (
							<span className="mt-2 flex flex-wrap gap-2">
								<Button asChild size="sm" variant="outline">
									<Link to="/repositories" search={{ q: "" }}>
										Connect a repository
										<ArrowRightIcon />
									</Link>
								</Button>
								<Button asChild size="sm" variant="ghost">
									<Link to="/onboarding">Open setup</Link>
								</Button>
							</span>
						) : null}
					</ConsoleNote>
				) : null}

				{optionsQuery.isLoading ? (
					<p className="text-xs text-ink-muted" aria-live="polite">
						Loading connected repositories and workflow versions…
					</p>
				) : null}

				{optionsUnavailable && !demo ? (
					<ConsoleNote role="note">
						The connected repository list is unavailable right now, so
						delegation is paused. Retry after the control plane reconnects.
					</ConsoleNote>
				) : null}

				<div className="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-4">
					<Button
						type="submit"
						disabled={
							readOnly ||
							blockedReason !== null ||
							mutation.isPending ||
							(mutation.isSuccess && mutation.data.ok)
						}
					>
						{mutation.isPending
							? "Delegating…"
							: request.current
								? "Retry same request"
								: "Delegate task"}
					</Button>
					<Button
						type="button"
						variant="ghost"
						disabled={mutation.isPending}
						onClick={() => {
							request.current = null;
							idempotencyKey.current = null;
							setValidationError(null);
							mutation.reset();
						}}
					>
						Start a new request
					</Button>
				</div>
			</form>

			<div aria-live="polite" className="space-y-3">
				{validationError ? (
					<ConsoleNote role="alert" tone="danger">
						{validationError}
					</ConsoleNote>
				) : null}
				{mutation.isError ? (
					<ConsoleNote role="alert" tone="danger">
						The request could not be confirmed. Retry the same request to avoid
						duplicates.
					</ConsoleNote>
				) : null}
				{mutation.isSuccess ? (
					mutation.data.ok ? (
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-l-2 border-success/50 py-2 pl-3 text-sm text-ink-secondary">
							<span className="text-ink">Task queued</span>
							<StatusMark status={mutation.data.value.task.status} />
							<Link
								to="/runs/$taskId"
								params={{ taskId: mutation.data.value.task.id }}
								className="font-mono text-xs text-brand hover:underline"
							>
								{shortId(mutation.data.value.task.id, 12)}
							</Link>
							<span className="text-xs text-ink-muted">
								Compiled plan{" "}
								<code className="font-mono">
									{shortId(mutation.data.value.compilation.compiledPlanId, 12)}
								</code>
							</span>
						</div>
					) : (
						<div
							role="alert"
							className="space-y-2 border-l-2 border-danger/60 py-2 pl-3 text-sm text-danger"
						>
							<p>{mutation.data.error.message}</p>
							{mutation.data.error.issues?.length ? (
								<ul className="list-disc space-y-1 pl-5 text-xs">
									{mutation.data.error.issues.map((issue) => (
										<li key={`${issue.code}:${issue.path}:${issue.message}`}>
											{issue.message}{" "}
											<code className="font-mono">{issue.path}</code>
										</li>
									))}
								</ul>
							) : null}
						</div>
					)
				) : null}
			</div>
		</PageContainer>
	);
}
