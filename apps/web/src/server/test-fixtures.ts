import "@tanstack/react-start/server-only";
import type { QueueRepository, TaskRepository, TaskRow } from "@isolate/db";
import {
	InMemoryQueueRepository,
	InMemoryTaskRepository,
} from "@isolate/db/testing";
import { asOrganizationId, asUserId, type TaskId } from "@isolate/shared";
import type { SubmitTaskInput } from "../features/tasks/contracts";
import { localDemo } from "./local-mode.server";
import {
	createRepositoryStore,
	summarizeTask,
} from "./repository-store.server";
import { type CallerScope, createTaskService } from "./task-service.server";

export const scope: CallerScope = {
	organizationId: localDemo.organizationId,
	userId: localDemo.userId,
};
export const otherScope: CallerScope = {
	organizationId: asOrganizationId("20000000-0000-4000-8000-000000000001"),
	userId: asUserId("20000000-0000-4000-8000-000000000002"),
};
export function input(
	overrides: Partial<SubmitTaskInput> = {},
): SubmitTaskInput {
	return {
		repositoryId: localDemo.repositoryId,
		branch: "task/offline",
		idempotencyKey: crypto.randomUUID(),
		budget: {},
		...overrides,
	};
}
export function harness() {
	class Tasks extends InMemoryTaskRepository {
		ids = new Set<TaskId>();
		calls: Parameters<TaskRepository["create"]>[0][] = [];
		fail = false;
		corruptOwner = false;
		override async create(value: Parameters<TaskRepository["create"]>[0]) {
			this.calls.push(value);
			if (this.fail)
				throw new Error("private storage detail: postgres://fake-secret");
			const task = await super.create(value);
			this.ids.add(task.id);
			return this.corruptOwner
				? { ...task, organization_id: otherScope.organizationId }
				: task;
		}
	}
	class Queue extends InMemoryQueueRepository {
		calls: Parameters<QueueRepository["enqueue"]>[0][] = [];
		fail = false;
		corruptOwner = false;
		override async enqueue(value: Parameters<QueueRepository["enqueue"]>[0]) {
			this.calls.push(value);
			if (this.fail)
				throw new Error("private queue detail: apiKey=fake-secret");
			const job = await super.enqueue(value);
			return this.corruptOwner
				? { ...job, organizationId: otherScope.organizationId }
				: job;
		}
	}
	const tasks = new Tasks();
	const queue = new Queue();
	let allowed = true;
	let listFails = false;
	let reads = 0;
	const store = createRepositoryStore({
		tasks,
		queue,
		repositoryBelongsToOrganization: async () => allowed,
		async listLatest(caller, limit) {
			if (listFails) throw new Error("private list detail");
			const rows = await Promise.all([...tasks.ids].map((id) => tasks.get(id)));
			return rows
				.filter(
					(row): row is TaskRow =>
						row !== null && row.organization_id === caller.organizationId,
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
	const serviceFor = (caller = scope) =>
		createTaskService({
			resolveScope: async () => caller,
			getStore: async () => {
				reads++;
				return store;
			},
		});
	return {
		tasks,
		queue,
		store,
		service: serviceFor(),
		serviceFor,
		denyRepository: () => {
			allowed = false;
		},
		failList: () => {
			listFails = true;
		},
		reads: () => reads,
	};
}
