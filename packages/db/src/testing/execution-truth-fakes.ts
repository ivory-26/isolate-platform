import type {
	ApprovalId,
	EventActor,
	ExecutionLifecycle,
	LifecycleApprovalInput,
	LifecycleApprovalState,
	LifecycleArtifactInput,
	LifecycleEventInput,
	LifecycleTransitionInput,
	OrganizationId,
	RunEventType,
	TaskId,
} from "@isolate/shared";
import {
	type ArtifactRepository,
	type CreateArtifactInput,
	type CreateArtifactResult,
	evaluateArtifactContent,
	MAX_INLINE_ARTIFACT_BYTES,
	validateCreateArtifactInput,
} from "../repositories/artifact-repository";
import {
	evaluateLifecycleApprovalStatus,
	LifecycleError,
	validateLifecycleApprovalInput,
	validateTransitionInput,
} from "../repositories/execution-lifecycle";
import {
	type CreateRepositoryInput,
	type CreateRepositoryResult,
	type RepositoryRepository,
	validateCreateRepositoryInput,
} from "../repositories/repository-repository";
import {
	requireNonEmpty,
	type TaskRepository,
} from "../repositories/task-repository";
import type {
	ApprovalRow,
	ArtifactRow,
	RepositoryRow,
	TaskRow,
} from "../schema";
import { InMemoryTaskRepository } from "./fakes";

/**
 * In-memory fakes for the wave-7 execution-truth stores.
 *
 * They carry the SAME constraints as the Postgres drivers: duplicate
 * repository full names are CONFLICT, artifact content is capped before
 * insert, lifecycle transitions go through the task repository (which uses
 * `guardTransition`), and every read filters by `organization_id`. The only
 * intentional simplification is concurrency: attempt allocation is atomic
 * because JavaScript is single-threaded here.
 */

function newUuid(): string {
	return crypto.randomUUID();
}

function cloneArtifact(row: ArtifactRow): ArtifactRow {
	return { ...row };
}

export class InMemoryRepositoryRepository implements RepositoryRepository {
	private readonly rows = new Map<string, RepositoryRow>();

	constructor(private readonly clock: () => Date = () => new Date()) {}

	async create(input: CreateRepositoryInput): Promise<CreateRepositoryResult> {
		const validated = validateCreateRepositoryInput(input);
		for (const row of this.rows.values()) {
			if (
				row.organization_id === validated.organizationId &&
				row.external_full_name === validated.externalFullName
			) {
				return { ok: false, code: "CONFLICT" };
			}
		}
		const row: RepositoryRow = {
			id: newUuid() as RepositoryRow["id"],
			organization_id: validated.organizationId,
			provider: validated.provider,
			external_full_name: validated.externalFullName,
			default_branch: validated.defaultBranch,
			created_at: this.clock(),
		};
		this.rows.set(row.id, row);
		return { ok: true, repository: { ...row } };
	}

	async get(input: {
		organizationId: OrganizationId;
		repositoryId: string;
	}): Promise<RepositoryRow | null> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.repositoryId, "repositoryId");
		const row = this.rows.get(input.repositoryId);
		if (!row || row.organization_id !== input.organizationId) return null;
		return { ...row };
	}

	async list(organizationId: OrganizationId): Promise<RepositoryRow[]> {
		requireNonEmpty(organizationId, "organizationId");
		return [...this.rows.values()]
			.filter((row) => row.organization_id === organizationId)
			.sort(
				(a, b) =>
					a.external_full_name.localeCompare(b.external_full_name) ||
					a.id.localeCompare(b.id),
			)
			.map((row) => ({ ...row }));
	}
}

/**
 * The artifact fake needs a task source to enforce tenant scope exactly like
 * the Postgres INSERT ... SELECT from `tasks` does.
 */
export class InMemoryArtifactRepository implements ArtifactRepository {
	private readonly rows: ArtifactRow[] = [];

	constructor(
		private readonly tasks: Pick<TaskRepository, "get">,
		private readonly clock: () => Date = () => new Date(),
	) {}

	async create(input: CreateArtifactInput): Promise<CreateArtifactResult> {
		const validated = validateCreateArtifactInput(input);
		const content = evaluateArtifactContent(validated.content);
		if (!content.ok) return content;
		const task = await this.tasks.get(validated.taskId);
		if (!task || task.organization_id !== validated.organizationId) {
			return { ok: false, code: "NOT_FOUND" };
		}
		const row: ArtifactRow = {
			id: newUuid(),
			task_id: validated.taskId,
			organization_id: validated.organizationId,
			kind: validated.kind,
			storage_ref: `inline:${validated.sha256}`,
			content_type: validated.contentType,
			byte_size: content.byteSize,
			sha256: validated.sha256,
			content: validated.content,
			created_at: this.clock(),
		};
		this.rows.push(row);
		return { ok: true, artifact: cloneArtifact(row) };
	}

	async listByTask(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
	}): Promise<ArtifactRow[]> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		return this.rows
			.filter(
				(row) =>
					row.organization_id === input.organizationId &&
					row.task_id === input.taskId,
			)
			.sort(
				(a, b) =>
					b.created_at.getTime() - a.created_at.getTime() ||
					b.id.localeCompare(a.id),
			)
			.map(cloneArtifact);
	}
}

export type StoredLifecycleEvent = {
	readonly organizationId: OrganizationId;
	readonly taskId: TaskId;
	readonly workflowRunId: string | null;
	readonly type: RunEventType;
	readonly actor: EventActor;
	readonly data: Record<string, unknown>;
	readonly occurredAt: Date;
};

export type InMemoryExecutionLifecycleOptions = {
	readonly tasks: TaskRepository;
	readonly artifacts: ArtifactRepository;
	readonly clock?: () => Date;
};

export class InMemoryExecutionLifecycle implements ExecutionLifecycle {
	private readonly approvals = new Map<ApprovalId, ApprovalRow>();
	private readonly events: StoredLifecycleEvent[] = [];
	private readonly attempts = new Map<
		string,
		{
			readonly taskId: TaskId;
			readonly attemptIndex: number;
			finishedAt: Date | null;
		}
	>();
	private readonly attemptCounters = new Map<TaskId, number>();
	private readonly clock: () => Date;

	constructor(private readonly options: InMemoryExecutionLifecycleOptions) {
		this.clock = options.clock ?? (() => new Date());
	}

	async transition(input: LifecycleTransitionInput): Promise<void> {
		validateTransitionInput(input);
		await this.requireTask(input.organizationId, input.taskId);
		const outcome = await this.options.tasks.transition({
			taskId: input.taskId,
			to: input.to,
			expectedStatus: input.from,
		});
		if (!outcome.ok) {
			throw new LifecycleError(
				outcome.code,
				outcome.code === "CONFLICT"
					? "task status changed since it was read"
					: "transition is not allowed by TASK_STATE_TRANSITIONS",
			);
		}
	}

	async event(input: LifecycleEventInput): Promise<void> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		requireNonEmpty(input.type, "type");
		requireNonEmpty(input.actor, "actor");
		await this.requireTask(input.organizationId, input.taskId);
		this.events.push({
			organizationId: input.organizationId,
			taskId: input.taskId,
			workflowRunId: input.workflowRunId,
			type: input.type,
			actor: input.actor,
			// Round-trip like jsonb does: drops undefined, rejects cycles.
			data: JSON.parse(JSON.stringify(input.data ?? {})) as Record<
				string,
				unknown
			>,
			occurredAt: this.clock(),
		});
	}

	async artifact(
		input: LifecycleArtifactInput,
	): Promise<{ readonly artifactId: string }> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		requireNonEmpty(input.contentType, "contentType");
		const result = await this.options.artifacts.create({
			organizationId: input.organizationId,
			taskId: input.taskId,
			kind: input.kind,
			contentType: input.contentType,
			content: input.content,
			sha256: input.sha256,
		});
		if (!result.ok) {
			if (result.code === "CONTENT_TOO_LARGE") {
				throw new LifecycleError(
					"INVALID_INPUT",
					`artifact content exceeds ${MAX_INLINE_ARTIFACT_BYTES} UTF-8 bytes`,
				);
			}
			throw new LifecycleError(
				"NOT_FOUND",
				"task not found in this organization",
			);
		}
		return { artifactId: result.artifact.id };
	}

	async attemptStarted(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		workflowRunId: string | null;
	}): Promise<{ readonly attemptId: string; readonly attemptIndex: number }> {
		await this.requireTask(input.organizationId, input.taskId);
		const attemptIndex = (this.attemptCounters.get(input.taskId) ?? 0) + 1;
		this.attemptCounters.set(input.taskId, attemptIndex);
		const attemptId = newUuid();
		this.attempts.set(attemptId, {
			taskId: input.taskId,
			attemptIndex,
			finishedAt: null,
		});
		return { attemptId, attemptIndex };
	}

	async attemptFinished(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		attemptId: string;
		outcome: Readonly<Record<string, unknown>> | null;
	}): Promise<void> {
		await this.requireTask(input.organizationId, input.taskId);
		const attempt = this.attempts.get(input.attemptId);
		if (!attempt || attempt.taskId !== input.taskId) {
			throw new LifecycleError(
				"NOT_FOUND",
				"attempt not found for this task in this organization",
			);
		}
		attempt.finishedAt = this.clock();
		if (input.outcome !== null) {
			// Validate jsonb round-trip without keeping a caller-owned reference.
			JSON.parse(JSON.stringify(input.outcome));
		}
	}

	async approvalRequested(
		input: LifecycleApprovalInput,
	): Promise<{ readonly approvalId: string }> {
		const validated = validateLifecycleApprovalInput(input);
		await this.requireTask(validated.organizationId, validated.taskId);
		for (const row of this.approvals.values()) {
			if (
				row.organization_id === validated.organizationId &&
				row.task_id === validated.taskId &&
				row.action === validated.action &&
				row.status === "pending"
			) {
				// A duplicate pending request is idempotent success; the stored
				// payload hash is NOT overwritten.
				return { approvalId: row.id };
			}
		}
		const row: ApprovalRow = {
			id: newUuid() as ApprovalId,
			organization_id: validated.organizationId,
			task_id: validated.taskId,
			workflow_run_id:
				validated.workflowRunId as ApprovalRow["workflow_run_id"],
			action: validated.action,
			payload_sha256: validated.payloadSha256,
			status: "pending",
			requested_by: validated.requestedBy,
			decided_by: null,
			decided_at: null,
			expires_at: new Date(validated.expiresAt),
			created_at: this.clock(),
		};
		this.approvals.set(row.id, row);
		return { approvalId: row.id };
	}

	async approvalStatus(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		approvalId: string;
	}): Promise<LifecycleApprovalState | null> {
		const task = await this.options.tasks.get(input.taskId);
		if (!task || task.organization_id !== input.organizationId) return null;
		const row = this.approvals.get(input.approvalId as ApprovalId);
		if (
			!row ||
			row.organization_id !== input.organizationId ||
			row.task_id !== input.taskId
		) {
			return null;
		}
		return {
			status: evaluateLifecycleApprovalStatus({
				status: row.status,
				expiresAtMs: row.expires_at.getTime(),
				nowMs: this.clock().getTime(),
			}),
			payloadSha256: row.payload_sha256,
		};
	}

	async isCancelled(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
	}): Promise<boolean> {
		const task = await this.requireTask(input.organizationId, input.taskId);
		return task.status === "cancelled";
	}

	/** Test introspection only; never part of the ExecutionLifecycle contract. */
	async listEvents(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
	}): Promise<StoredLifecycleEvent[]> {
		return this.events
			.filter(
				(event) =>
					event.organizationId === input.organizationId &&
					event.taskId === input.taskId,
			)
			.map((event) => ({ ...event, data: { ...event.data } }));
	}

	private async requireTask(
		organizationId: OrganizationId,
		taskId: TaskId,
	): Promise<TaskRow> {
		requireNonEmpty(organizationId, "organizationId");
		requireNonEmpty(taskId, "taskId");
		const task = await this.options.tasks.get(taskId);
		if (!task || task.organization_id !== organizationId) {
			throw new LifecycleError(
				"NOT_FOUND",
				"task not found in this organization",
			);
		}
		return task;
	}
}

/**
 * Wires the in-memory execution-truth stack used by offline tests and the
 * wave-7 acceptance script. The artifact repository and lifecycle share the
 * same task repository, so tenant checks agree.
 */
export function createInMemoryExecutionTruth(
	clock: () => Date = () => new Date(),
): {
	readonly tasks: InMemoryTaskRepository;
	readonly repositories: InMemoryRepositoryRepository;
	readonly artifacts: InMemoryArtifactRepository;
	readonly lifecycle: InMemoryExecutionLifecycle;
} {
	const tasks = new InMemoryTaskRepository();
	const repositories = new InMemoryRepositoryRepository(clock);
	const artifacts = new InMemoryArtifactRepository(tasks, clock);
	const lifecycle = new InMemoryExecutionLifecycle({
		tasks,
		artifacts,
		clock,
	});
	return { tasks, repositories, artifacts, lifecycle };
}
