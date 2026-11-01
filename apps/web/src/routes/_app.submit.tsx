import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useSession } from "@/components/auth/SessionProvider";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { Section } from "@/components/common/section";
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
import { submitOptionsQueryOptions } from "@/features/overview/queries";
import {
	type SubmitTaskInput,
	submitTaskSchema,
} from "@/features/tasks/contracts";
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

function splitLines(value: FormDataEntryValue | null): string[] {
	if (typeof value !== "string") return [];
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

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
		<div className="space-y-1.5">
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
			{hint ? <p className="text-xs leading-5 text-ink-muted">{hint}</p> : null}
		</div>
	);
}

function SubmitPage() {
	const queryClient = useQueryClient();
	const request = useRef<SubmitTaskInput | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);
	const session = useSession();
	const readOnly = activeRole(session) === "viewer";

	const optionsQuery = useQuery(submitOptionsQueryOptions());
	const options = optionsQuery.data?.ok ? optionsQuery.data.value : null;
	const repositories = options?.repositories ?? [];
	const workflows = options?.workflows ?? [];

	// The local demo seeds one repository and one workflow version; those ids
	// are the documented defaults and stay prefilled when live reads are off.
	const demoRepositoryId =
		session.mode === "demo" ? "10000000-0000-4000-8000-000000000003" : "";
	const demoDefinitionId =
		session.mode === "demo" ? "10000000-0000-4000-8000-000000000004" : "";

	const [repositoryId, setRepositoryId] = useState(demoRepositoryId);
	const [definitionId, setDefinitionId] = useState(demoDefinitionId);
	const selectedWorkflow = workflows.find(
		(workflow) => workflow.id === definitionId,
	);
	const versions = selectedWorkflow?.versions ?? [];
	const [version, setVersion] = useState(versions[0] ?? 1);

	const onDefinitionChange = (nextId: string) => {
		setDefinitionId(nextId);
		const next = workflows.find((workflow) => workflow.id === nextId);
		setVersion(next?.versions[0] ?? 1);
	};

	const optionsUnavailable =
		optionsQuery.isError ||
		(optionsQuery.data !== undefined && !optionsQuery.data.ok);

	const mutation = useMutation({
		mutationFn: (data: SubmitTaskInput) => submitTask({ data }),
		onSuccess: async (result) => {
			if (result.ok) {
				await queryClient.invalidateQueries({ queryKey: taskKeys.all });
			}
		},
	});
	const locked = mutation.isPending || request.current !== null || readOnly;

	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Submit a task"
				description="Queue one bounded engineering task. Organization and actor are resolved on the server; your role decides whether you may submit."
			/>
			{readOnly ? (
				<div
					role="alert"
					className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning"
				>
					Your role in this organization is read-only. Ask an owner or admin for
					submit access.
				</div>
			) : null}
			{session.mode === "demo" ? (
				<div className="rounded-md border border-line-subtle bg-elevated px-3 py-2 text-xs leading-5 text-ink-muted">
					Local demo: data is temporary and no worker executes it. The demo
					repository{" "}
					<code className="font-mono">
						10000000-0000-4000-8000-000000000003
					</code>{" "}
					and workflow{" "}
					<code className="font-mono">
						10000000-0000-4000-8000-000000000004
					</code>{" "}
					version <code className="font-mono">1</code> are prefilled below.
				</div>
			) : null}

			<form
				className="space-y-6"
				onSubmit={(event) => {
					event.preventDefault();
					if (mutation.isPending || (mutation.isSuccess && mutation.data.ok)) {
						return;
					}
					const form = new FormData(event.currentTarget);
					const parsed = submitTaskSchema.safeParse(
						request.current ?? {
							repositoryId: String(form.get("repositoryId") ?? ""),
							branch: String(form.get("branch") ?? ""),
							idempotencyKey: crypto.randomUUID(),
							workflowDefinitionId: String(
								form.get("workflowDefinitionId") ?? "",
							),
							workflowVersion: Number(form.get("workflowVersion")),
							goal: String(form.get("goal") ?? ""),
							acceptanceCriteria: splitLines(form.get("acceptanceCriteria")),
							fileOwnership: splitLines(form.get("fileOwnership")),
							budget: {
								maxAgentTurns: Number(form.get("maxAgentTurns")),
								repairBudget: Number(form.get("repairBudget")),
								jobTimeoutMs: Number(form.get("jobTimeoutMs")),
							},
						},
					);
					if (!parsed.success) {
						setValidationError(
							"Enter a goal, a valid repository UUID, a pinned workflow definition and version, a task branch and bounded execution limits.",
						);
						return;
					}
					setValidationError(null);
					request.current = parsed.data;
					mutation.mutate(parsed.data);
				}}
			>
				<fieldset disabled={locked} className="space-y-6">
					<Section
						title="Repository and workflow"
						description="The task is compiled against one immutable workflow version before it is queued."
					>
						<div className="grid gap-4 md:grid-cols-2">
							<Field
								label="Repository"
								htmlFor="repositoryId"
								hint="A repository record already connected to this organization."
							>
								{repositories.length > 0 ? (
									<>
										<input
											type="hidden"
											name="repositoryId"
											value={repositoryId}
											readOnly
										/>
										<Select
											value={repositoryId || undefined}
											onValueChange={setRepositoryId}
										>
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
									</>
								) : (
									<Input
										id="repositoryId"
										name="repositoryId"
										required
										placeholder="00000000-0000-4000-8000-000000000000"
										defaultValue={demoRepositoryId || undefined}
										autoComplete="off"
										spellCheck={false}
									/>
								)}
							</Field>
							<Field
								label="Task branch"
								htmlFor="branch"
								hint="The worker commits only to this branch."
							>
								<Input
									id="branch"
									name="branch"
									required
									maxLength={120}
									defaultValue="task/web-demo"
									autoComplete="off"
									spellCheck={false}
								/>
							</Field>
							<Field
								label="Workflow"
								htmlFor="workflowDefinitionId"
								hint="The authored definition, not the compiled plan."
							>
								{workflows.length > 0 ? (
									<>
										<input
											type="hidden"
											name="workflowDefinitionId"
											value={definitionId}
											readOnly
										/>
										<Select
											value={definitionId || undefined}
											onValueChange={onDefinitionChange}
										>
											<SelectTrigger
												id="workflowDefinitionId"
												className="w-full"
											>
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
									</>
								) : (
									<Input
										id="workflowDefinitionId"
										name="workflowDefinitionId"
										required
										placeholder="00000000-0000-4000-8000-000000000000"
										defaultValue={demoDefinitionId || undefined}
										autoComplete="off"
										spellCheck={false}
									/>
								)}
							</Field>
							<Field
								label="Pinned workflow version"
								htmlFor="workflowVersion"
								hint="Versions are immutable; a new edit publishes a new version."
							>
								{versions.length > 0 ? (
									<>
										<input
											type="hidden"
											name="workflowVersion"
											value={String(version)}
											readOnly
										/>
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
									</>
								) : (
									<Input
										id="workflowVersion"
										name="workflowVersion"
										type="number"
										min={1}
										max={2147483647}
										defaultValue={1}
										required
									/>
								)}
							</Field>
						</div>
						{optionsQuery.isLoading ? (
							<p className="text-xs text-ink-muted">
								Loading connected repositories and workflow versions…
							</p>
						) : null}
						{optionsUnavailable ? (
							<p className="text-xs leading-5 text-ink-muted">
								The connected repository and workflow lists are unavailable, so
								enter the UUIDs directly. Your submission is still validated on
								the server.
							</p>
						) : null}
					</Section>

					<Section
						title="Intent and boundaries"
						description="The worker receives exactly this text. File ownership bounds every write."
					>
						<div className="space-y-4">
							<Field
								label="Goal"
								htmlFor="goal"
								hint="What should the agent accomplish? Be specific and bounded."
							>
								<Textarea
									id="goal"
									name="goal"
									required
									maxLength={4000}
									rows={4}
									placeholder="Fix the failing checkout test and add a regression case."
								/>
							</Field>
							<div className="grid gap-4 md:grid-cols-2">
								<Field
									label="Acceptance criteria"
									htmlFor="acceptanceCriteria"
									hint="One criterion per line."
								>
									<Textarea
										id="acceptanceCriteria"
										name="acceptanceCriteria"
										rows={4}
										placeholder={
											"All tests pass\nNo files outside the ownership list change"
										}
									/>
								</Field>
								<Field
									label="File ownership"
									htmlFor="fileOwnership"
									hint="One path or glob per line."
								>
									<Textarea
										id="fileOwnership"
										name="fileOwnership"
										rows={4}
										placeholder={"apps/web/**\npackages/shared/**"}
									/>
								</Field>
							</div>
						</div>
					</Section>

					<Section
						title="Execution limits"
						description="Every limit stops the task at the cap. The environment decides completion, not the model."
					>
						<div className="grid gap-4 md:grid-cols-3">
							<Field label="Maximum agent turns" htmlFor="maxAgentTurns">
								<Input
									id="maxAgentTurns"
									name="maxAgentTurns"
									type="number"
									min={1}
									max={50}
									defaultValue={12}
									required
								/>
							</Field>
							<Field label="Maximum repair attempts" htmlFor="repairBudget">
								<Input
									id="repairBudget"
									name="repairBudget"
									type="number"
									min={0}
									max={5}
									defaultValue={2}
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
									name="jobTimeoutMs"
									type="number"
									min={1000}
									max={3600000}
									defaultValue={120000}
									required
								/>
							</Field>
						</div>
					</Section>
				</fieldset>

				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="submit"
						disabled={
							readOnly ||
							mutation.isPending ||
							(mutation.isSuccess && mutation.data.ok)
						}
					>
						{mutation.isPending
							? "Submitting…"
							: request.current
								? "Retry same request"
								: "Queue task"}
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={mutation.isPending}
						onClick={() => {
							request.current = null;
							setValidationError(null);
							mutation.reset();
						}}
					>
						Start a new request
					</Button>
				</div>
			</form>

			<div aria-live="polite" className="space-y-4">
				{validationError ? (
					<div
						role="alert"
						className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
					>
						{validationError}
					</div>
				) : null}
				{mutation.isError ? (
					<div
						role="alert"
						className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
					>
						The request could not be confirmed. Retry the same request to avoid
						duplicates.
					</div>
				) : null}
				{mutation.isSuccess ? (
					mutation.data.ok ? (
						<Section title="Task queued">
							<div className="space-y-2 text-sm text-ink-secondary">
								<p>
									Task{" "}
									<Link
										to="/runs/$taskId"
										params={{ taskId: mutation.data.value.task.id }}
										className="font-mono text-brand hover:underline"
									>
										{shortId(mutation.data.value.task.id, 12)}
									</Link>{" "}
									is {mutation.data.value.task.status}.
								</p>
								<p>
									Compiled plan{" "}
									<code className="font-mono text-xs">
										{shortId(
											mutation.data.value.compilation.compiledPlanId,
											12,
										)}
									</code>{" "}
									is pinned for this submission.
								</p>
								<Button asChild variant="outline" size="sm">
									<Link
										to="/runs/$taskId"
										params={{ taskId: mutation.data.value.task.id }}
									>
										Open run detail
									</Link>
								</Button>
							</div>
						</Section>
					) : (
						<div
							role="alert"
							className="space-y-2 rounded-md border border-danger/30 bg-danger/5 p-4 text-sm text-danger"
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
