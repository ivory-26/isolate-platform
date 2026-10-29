import "@tanstack/react-start/server-only";
import type { QueueRepository, TaskRepository, TaskRow } from "@isolate/db";
import {
	InMemoryQueueRepository,
	InMemoryTaskRepository,
} from "@isolate/db/testing";
import { asOrganizationId, asUserId, type TaskId } from "@isolate/shared";
import type {
	SubmitTaskInput,
	WorkflowRejectionIssue,
} from "../features/tasks/contracts";
import { localDemo } from "./local-mode.server";
import {
	createRepositoryStore,
	summarizeTask,
} from "./repository-store.server";
import type {
	CompileSubmission,
	SubmissionPin,
} from "./submission-compilation.server";
import { type CallerScope, createTaskService } from "./task-service.server";
import type { WorkflowCompilationResult } from "./workflow-compilation.server";

export const scope: CallerScope = {
	organizationId: localDemo.organizationId,
	userId: localDemo.userId,
	role: "owner",
};
export const otherScope: CallerScope = {
	organizationId: asOrganizationId("20000000-0000-4000-8000-000000000001"),
	userId: asUserId("20000000-0000-4000-8000-000000000002"),
	role: "owner",
};
export const workflowPin = {
	workflowDefinitionId: localDemo.workflowDefinitionId,
	workflowVersion: localDemo.workflowVersion,
} as const;
export function input(
	overrides: Partial<SubmitTaskInput> = {},
): SubmitTaskInput {
	return {
		repositoryId: localDemo.repositoryId,
		branch: "task/offline",
		idempotencyKey: crypto.randomUUID(),
		goal: "Complete the offline task",
		acceptanceCriteria: ["All gates pass"],
		fileOwnership: ["apps/web/**"],
		...workflowPin,
		budget: {},
		...overrides,
	};
}
export type FakeCompilationOutcome =
	| "compiled"
	| "rejected"
	| "conflict"
	| "not_found"
	| "forbidden"
	| "storage";
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
	let repositoryOwners: Map<string, string> | null = null;
	let listFails = false;
	let reads = 0;
	const compilation = {
		outcome: "compiled" as FakeCompilationOutcome,
		compiledPlanId: crypto.randomUUID(),
		issues: [
			{
				code: "UNSAFE_CONFIG",
				path: "nodes[0].config",
				message:
					"The workflow contains unsupported or unbounded configuration.",
			},
		] as WorkflowRejectionIssue[],
		calls: [] as Array<{ scope: CallerScope; pin: SubmissionPin }>,
	} as {
		outcome: FakeCompilationOutcome;
		compiledPlanId: string;
		issues: WorkflowRejectionIssue[];
		calls: Array<{ scope: CallerScope; pin: SubmissionPin }>;
		compile: CompileSubmission;
	};
	compilation.compile = async (caller, pin) => {
		compilation.calls.push({ scope: caller, pin });
		const fullPin = {
			organizationId: caller.organizationId,
			...pin,
		};
		const result = (): WorkflowCompilationResult => {
			switch (compilation.outcome) {
				case "compiled":
					return {
						outcome: "compiled",
						pin: fullPin,
						compiledPlanId: compilation.compiledPlanId,
					};
				case "rejected":
					return {
						outcome: "rejected",
						pin: fullPin,
						rejectionId: crypto.randomUUID(),
						issues: compilation.issues,
					};
				case "conflict":
					return { outcome: "conflict", pin: fullPin };
				case "not_found":
					return {
						outcome: "error",
						error: {
							code: "NOT_FOUND",
							message: "private authored lookup fixture-secret",
						},
					};
				case "forbidden":
					return {
						outcome: "error",
						error: {
							code: "FORBIDDEN",
							message: "private policy fixture-secret",
						},
					};
				case "storage":
					return {
						outcome: "error",
						error: {
							code: "STORAGE_FAILURE",
							message: "postgres://fixture-secret",
						},
					};
			}
		};
		return result();
	};
	const store = createRepositoryStore({
		tasks,
		queue,
		repositoryBelongsToOrganization: async (org, repo) =>
			allowed &&
			(repositoryOwners === null || repositoryOwners.get(repo) === org),
		compileSubmission: compilation.compile,
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
		compilation,
		service: serviceFor(),
		serviceFor,
		denyRepository: () => {
			allowed = false;
		},
		ownRepository: (repositoryId: string, organizationId: string) => {
			repositoryOwners ??= new Map();
			repositoryOwners.set(repositoryId, organizationId);
		},
		failList: () => {
			listFails = true;
		},
		reads: () => reads,
	};
}
