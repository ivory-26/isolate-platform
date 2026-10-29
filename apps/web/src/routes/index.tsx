import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useSession } from "../components/auth/SessionProvider";
import { activeRole, requireSession } from "../features/auth/guard";
import { authStateOptions } from "../features/auth/queries";
import {
	type SubmitTaskInput,
	submitTaskSchema,
} from "../features/tasks/contracts";
import { taskKeys } from "../features/tasks/queries";
import { submitTask } from "../features/tasks/tasks.functions";

export const Route = createFileRoute("/")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		return requireSession(state);
	},
	component: SubmitPage,
});
function SubmitPage() {
	const queryClient = useQueryClient();
	const request = useRef<SubmitTaskInput | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);
	const state = useSession();
	// A viewer may read the tenant's tasks but never queue one.
	const readOnly = activeRole(state) === "viewer";
	const mutation = useMutation({
		mutationFn: (data: SubmitTaskInput) => submitTask({ data }),
		onSuccess: async (result) => {
			if (result.ok)
				await queryClient.invalidateQueries({ queryKey: taskKeys.all });
		},
	});
	return (
		<main>
			<p className="eyebrow">Task control plane</p>
			<h1>Queue a bounded task</h1>
			<p>
				Organization and actor are resolved on the server, never from this form.
				Your role in the active organization decides what you may queue.
			</p>
			{readOnly && (
				<p role="alert">
					Your role in this organization is read-only. Ask an owner or admin for
					submit access.
				</p>
			)}
			<aside>
				Local demo requires explicit development/test mode, WEB_LOCAL_DEMO=true
				and no database configuration. Demo repository:{" "}
				<code>10000000-0000-4000-8000-000000000003</code>; demo workflow:{" "}
				<code>10000000-0000-4000-8000-000000000004</code> version <code>1</code>
				. Data is temporary; no worker executes it. Submissions compile the
				pinned version before a task is created.
			</aside>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (mutation.isPending || (mutation.isSuccess && mutation.data.ok))
						return;
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
							budget: {
								maxAgentTurns: Number(form.get("maxAgentTurns")),
								repairBudget: Number(form.get("repairBudget")),
								jobTimeoutMs: Number(form.get("jobTimeoutMs")),
							},
						},
					);
					if (!parsed.success) {
						setValidationError(
							"Enter a valid repository UUID, pinned workflow definition/version, task branch and bounded execution limits.",
						);
						return;
					}
					setValidationError(null);
					request.current = parsed.data;
					mutation.mutate(parsed.data);
				}}
			>
				<fieldset
					disabled={mutation.isPending || request.current !== null || readOnly}
				>
					<legend>Repository and execution limits</legend>
					<label htmlFor="repositoryId">Repository ID</label>
					<input
						id="repositoryId"
						name="repositoryId"
						required
						placeholder="Repository UUID"
					/>
					<label htmlFor="branch">Task branch</label>
					<input
						id="branch"
						name="branch"
						required
						maxLength={120}
						defaultValue="task/web-demo"
					/>
					<label htmlFor="workflowDefinitionId">Workflow definition ID</label>
					<input
						id="workflowDefinitionId"
						name="workflowDefinitionId"
						required
						placeholder="Workflow definition UUID"
						defaultValue="10000000-0000-4000-8000-000000000004"
					/>
					<label htmlFor="workflowVersion">Pinned workflow version</label>
					<input
						id="workflowVersion"
						name="workflowVersion"
						type="number"
						min={1}
						max={2147483647}
						defaultValue={1}
						required
					/>
					<label htmlFor="maxAgentTurns">Maximum agent turns</label>
					<input
						id="maxAgentTurns"
						name="maxAgentTurns"
						type="number"
						min={1}
						max={50}
						defaultValue={12}
						required
					/>
					<label htmlFor="repairBudget">Maximum repair attempts</label>
					<input
						id="repairBudget"
						name="repairBudget"
						type="number"
						min={0}
						max={5}
						defaultValue={2}
						required
					/>
					<label htmlFor="jobTimeoutMs">Duration budget (milliseconds)</label>
					<input
						id="jobTimeoutMs"
						name="jobTimeoutMs"
						type="number"
						min={1000}
						max={3600000}
						defaultValue={120000}
						required
					/>
				</fieldset>
				<button
					type="submit"
					disabled={
						readOnly ||
						mutation.isPending ||
						(mutation.isSuccess && mutation.data.ok)
					}
				>
					{mutation.isPending
						? "Submitting..."
						: request.current
							? "Retry same request"
							: "Queue task"}
				</button>
				<button
					type="button"
					disabled={mutation.isPending}
					onClick={() => {
						request.current = null;
						setValidationError(null);
						mutation.reset();
					}}
				>
					Start a new request
				</button>
			</form>
			<div aria-live="polite">
				{validationError && <p role="alert">{validationError}</p>}
				{mutation.isError && (
					<p role="alert">
						Request could not be confirmed. Retry the same request to avoid
						duplicates.
					</p>
				)}
				{mutation.isSuccess &&
					(mutation.data.ok ? (
						<section>
							<h2>Task queued</h2>
							<p>
								Task <code>{mutation.data.value.task.id}</code> is{" "}
								{mutation.data.value.task.status}. Compiled plan{" "}
								<code>{mutation.data.value.compilation.compiledPlanId}</code> is
								pinned for this submission.
							</p>
							<Link to="/runs">View tasks and runs</Link>
						</section>
					) : (
						<>
							<p role="alert">{mutation.data.error.message}</p>
							{mutation.data.error.code === "WORKFLOW_REJECTED" &&
								mutation.data.error.issues && (
									<ul>
										{mutation.data.error.issues.map((issue) => (
											<li key={`${issue.code}:${issue.path}:${issue.message}`}>
												{issue.message} <code>{issue.path}</code>{" "}
												<small>{issue.code}</small>
											</li>
										))}
									</ul>
								)}
						</>
					))}
			</div>
		</main>
	);
}
