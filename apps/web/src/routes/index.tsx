import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
	type SubmitTaskInput,
	submitTaskSchema,
} from "../features/tasks/contracts";
import { taskKeys } from "../features/tasks/queries";
import { submitTask } from "../features/tasks/tasks.functions";

export const Route = createFileRoute("/")({ component: SubmitPage });
function SubmitPage() {
	const queryClient = useQueryClient();
	const request = useRef<SubmitTaskInput | null>(null);
	const [validationError, setValidationError] = useState<string | null>(null);
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
				Production is locked until trusted authentication is integrated.
			</p>
			<aside>
				Local demo requires explicit development/test mode, WEB_LOCAL_DEMO=true
				and no database configuration. Demo repository:{" "}
				<code>10000000-0000-4000-8000-000000000003</code>. Data is temporary; no
				worker executes it.
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
							budget: {
								maxAgentTurns: Number(form.get("maxAgentTurns")),
								repairBudget: Number(form.get("repairBudget")),
								jobTimeoutMs: Number(form.get("jobTimeoutMs")),
							},
						},
					);
					if (!parsed.success) {
						setValidationError(
							"Enter a valid repository UUID, task branch and bounded execution limits.",
						);
						return;
					}
					setValidationError(null);
					request.current = parsed.data;
					mutation.mutate(parsed.data);
				}}
			>
				<fieldset disabled={mutation.isPending || request.current !== null}>
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
						mutation.isPending || (mutation.isSuccess && mutation.data.ok)
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
								{mutation.data.value.task.status}.
							</p>
							<Link to="/runs">View tasks and runs</Link>
						</section>
					) : (
						<p role="alert">{mutation.data.error.message}</p>
					))}
			</div>
		</main>
	);
}
