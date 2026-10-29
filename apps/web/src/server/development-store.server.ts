import "@tanstack/react-start/server-only";
import type { TaskRepository, TaskRow } from "@isolate/db";
import {
	createInMemoryWorkflowCompilationRepositories,
	InMemoryQueueRepository,
	InMemoryTaskRepository,
} from "@isolate/db/testing";
import type { TaskId } from "@isolate/shared";
import { createDevelopmentAuthoredVersions } from "./development-workflows.server";
import {
	localDemo,
	type RuntimeConfig,
	resolveLocalScope,
} from "./local-mode.server";
import {
	createRepositoryStore,
	summarizeTask,
} from "./repository-store.server";
import { createSubmissionCompiler } from "./submission-compilation.server";
import type { TaskStore } from "./task-service.server";

export function createDevelopmentStore(config: RuntimeConfig): TaskStore {
	resolveLocalScope(config);
	const ids = new Set<TaskId>();
	// Avoid the fake's global, limit-before-tenant-filter status scan.
	class TrackedTasks extends InMemoryTaskRepository {
		override async create(input: Parameters<TaskRepository["create"]>[0]) {
			const task = await super.create(input);
			ids.add(task.id);
			return task;
		}
	}
	const tasks = new TrackedTasks();
	const demoPin = {
		organizationId: localDemo.organizationId,
		workflowDefinitionId: localDemo.workflowDefinitionId,
		workflowVersion: localDemo.workflowVersion,
	};
	const { compiledPlans, rejections } =
		createInMemoryWorkflowCompilationRepositories({ versions: [demoPin] });
	const authoredVersions = createDevelopmentAuthoredVersions();
	const compileSubmission = createSubmissionCompiler({
		getRepositories: async () => ({
			authoredVersions,
			compiledPlans,
			rejections,
		}),
		// The local demo has exactly one organization and one owner.
		authorizeMembership: async (scope) =>
			scope.organizationId === localDemo.organizationId &&
			scope.userId === localDemo.userId,
	});
	return createRepositoryStore({
		tasks,
		queue: new InMemoryQueueRepository(),
		repositoryBelongsToOrganization: async (org, repo) =>
			org === localDemo.organizationId && repo === localDemo.repositoryId,
		compileSubmission,
		async listLatest(scope, limit) {
			const rows = await Promise.all([...ids].map((id) => tasks.get(id)));
			return rows
				.filter(
					(row): row is TaskRow =>
						row !== null && row.organization_id === scope.organizationId,
				)
				.sort(
					(a, b) =>
						b.created_at.getTime() - a.created_at.getTime() ||
						b.id.localeCompare(a.id),
				)
				.slice(0, limit)
				.map(summarizeTask);
		},
	});
}
