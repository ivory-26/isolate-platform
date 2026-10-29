import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { requireSession } from "../features/auth/guard";
import { authStateOptions } from "../features/auth/queries";
import { latestTasksOptions } from "../features/tasks/queries";

export const Route = createFileRoute("/runs")({
	loader: async ({ context }) => {
		// The list is organization-scoped, so a trusted session comes first.
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		requireSession(state);
		return context.queryClient.ensureQueryData(latestTasksOptions());
	},
	pendingComponent: () => (
		<main>
			<output>Loading tasks...</output>
		</main>
	),
	component: RunsPage,
});
function RunsPage() {
	const query = useSuspenseQuery(latestTasksOptions());
	return (
		<main>
			<p className="eyebrow">Current organization</p>
			<h1>Latest tasks &amp; runs</h1>
			<p>
				The latest 25 tasks, newest first. Runs appear only after a worker
				creates one.
			</p>
			<button
				type="button"
				disabled={query.isFetching}
				onClick={() => void query.refetch()}
			>
				{query.isFetching ? "Refreshing..." : "Refresh"}
			</button>
			{query.isRefetchError && (
				<p role="alert">Refresh failed. The list below may be stale.</p>
			)}
			{!query.data.ok ? (
				<p role="alert">{query.data.error.message}</p>
			) : query.data.value.length === 0 ? (
				<p>
					No tasks yet. <Link to="/">Submit a task</Link>.
				</p>
			) : (
				<div className="table-scroll">
					<table>
						<caption>Organization-scoped tasks</caption>
						<thead>
							<tr>
								<th scope="col">Task / repository</th>
								<th scope="col">Branch</th>
								<th scope="col">Task status</th>
								<th scope="col">Created (UTC)</th>
								<th scope="col">Latest run</th>
							</tr>
						</thead>
						<tbody>
							{query.data.value.map((task) => (
								<tr key={task.id}>
									<td>
										<code>{task.id}</code>
										<br />
										<small>{task.repositoryId}</small>
									</td>
									<td>{task.branch}</td>
									<td>{task.status}</td>
									<td>
										<time dateTime={task.createdAt}>{task.createdAt}</time>
									</td>
									<td>
										{task.latestRun ? (
											<>
												<code>{task.latestRun.id}</code>
												<br />
												{task.latestRun.status}
												<br />
												<time dateTime={task.latestRun.startedAt}>
													{task.latestRun.startedAt}
												</time>
											</>
										) : (
											"Not started"
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</main>
	);
}
