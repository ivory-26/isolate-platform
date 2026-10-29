import type { OrganizationId, WorkflowDefinitionId } from "@isolate/shared";
import {
	type CompiledPlanRepository,
	type CompiledPlanVersionSummary,
	evaluatePlanSaveOutcome,
	type SavePlanInput,
	type SavePlanResult,
} from "../repositories/compiled-plan-repository";
import {
	evaluateWorkflowVersion,
	sameWorkflowPin,
	validateCompiledPlan,
	validateRejectionIssues,
	validateRejectionLimit,
	validateWorkflowPin,
	validateWorkflowScope,
	type WorkflowVersionPin,
} from "../repositories/workflow-compilation";
import type {
	RecordWorkflowRejectionInput,
	RecordWorkflowRejectionResult,
	WorkflowRejectionRepository,
} from "../repositories/workflow-rejection-repository";
import type { CompiledPlanRow, WorkflowRejectionRow } from "../schema";

export type InMemoryWorkflowCompilationOptions = {
	/** Existing authored versions. Empty by default: unregistered pins fail closed. */
	versions?: readonly WorkflowVersionPin[];
	now?: () => Date;
};

function snapshotPins(
	versions: readonly WorkflowVersionPin[],
): WorkflowVersionPin[] {
	const owners = new Map<WorkflowDefinitionId, OrganizationId>();
	return versions.map((pin) => {
		validateWorkflowPin(pin);
		const owner = owners.get(pin.workflowDefinitionId);
		if (owner !== undefined && owner !== pin.organizationId) {
			throw new Error(
				"a workflow definition cannot belong to multiple organizations",
			);
		}
		owners.set(pin.workflowDefinitionId, pin.organizationId);
		return { ...pin };
	});
}

function rowPin(
	row: CompiledPlanRow | WorkflowRejectionRow,
): WorkflowVersionPin {
	return {
		organizationId: row.organization_id,
		workflowDefinitionId: row.workflow_definition_id,
		workflowVersion: row.workflow_version,
	};
}

export class InMemoryCompiledPlanRepository implements CompiledPlanRepository {
	private readonly rows: CompiledPlanRow[] = [];
	private readonly versions: WorkflowVersionPin[];
	private readonly now: () => Date;

	constructor(options: InMemoryWorkflowCompilationOptions = {}) {
		this.versions = snapshotPins(options.versions ?? []);
		this.now = options.now ?? (() => new Date());
	}

	async save(input: SavePlanInput): Promise<SavePlanResult> {
		const json = validateCompiledPlan(input);
		const outcome = evaluatePlanSaveOutcome({
			versionExists: this.versions.some((pin) => sameWorkflowPin(pin, input)),
			alreadySaved: this.rows.some((row) =>
				sameWorkflowPin(rowPin(row), input),
			),
		});
		if (!outcome.ok) return outcome;
		const row: CompiledPlanRow = {
			id: crypto.randomUUID(),
			organization_id: input.organizationId,
			workflow_definition_id: input.workflowDefinitionId,
			workflow_version: input.workflowVersion,
			plan: JSON.parse(json),
			created_at: new Date(this.now()),
		};
		this.rows.push(row);
		return { ok: true, plan: structuredClone(row) };
	}

	async get(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
		workflowVersion: number,
	): Promise<CompiledPlanRow | null> {
		const pin = { organizationId, workflowDefinitionId, workflowVersion };
		validateWorkflowPin(pin);
		const row = this.rows.find((row) => sameWorkflowPin(rowPin(row), pin));
		return row ? structuredClone(row) : null;
	}

	async list(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
	): Promise<CompiledPlanRow[]> {
		validateWorkflowScope(organizationId, workflowDefinitionId);
		return this.rows
			.filter(
				(row) =>
					row.organization_id === organizationId &&
					row.workflow_definition_id === workflowDefinitionId,
			)
			.sort((a, b) => b.workflow_version - a.workflow_version)
			.map((row) => structuredClone(row));
	}

	async listVersions(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
	): Promise<CompiledPlanVersionSummary[]> {
		return (await this.list(organizationId, workflowDefinitionId)).map(
			({ id, workflow_version, created_at }) => ({
				id,
				workflow_version,
				created_at,
			}),
		);
	}
}

export class InMemoryWorkflowRejectionRepository
	implements WorkflowRejectionRepository
{
	private readonly rows: WorkflowRejectionRow[] = [];
	private readonly versions: WorkflowVersionPin[];
	private readonly now: () => Date;

	constructor(options: InMemoryWorkflowCompilationOptions = {}) {
		this.versions = snapshotPins(options.versions ?? []);
		this.now = options.now ?? (() => new Date());
	}

	async record(
		input: RecordWorkflowRejectionInput,
	): Promise<RecordWorkflowRejectionResult> {
		const json = validateRejectionIssues(input);
		const outcome = evaluateWorkflowVersion(
			this.versions.some((pin) => sameWorkflowPin(pin, input)),
		);
		if (!outcome.ok) return outcome;
		const row: WorkflowRejectionRow = {
			id: crypto.randomUUID(),
			organization_id: input.organizationId,
			workflow_definition_id: input.workflowDefinitionId,
			workflow_version: input.workflowVersion,
			issues: JSON.parse(json),
			created_at: new Date(this.now()),
		};
		this.rows.push(row);
		return { ok: true, rejection: structuredClone(row) };
	}

	async listLatest(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
		workflowVersion: number,
		limit = 50,
	): Promise<WorkflowRejectionRow[]> {
		const pin = { organizationId, workflowDefinitionId, workflowVersion };
		validateWorkflowPin(pin);
		validateRejectionLimit(limit);
		return this.rows
			.filter((row) => sameWorkflowPin(rowPin(row), pin))
			.sort(
				(a, b) =>
					b.created_at.getTime() - a.created_at.getTime() ||
					(a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
			)
			.slice(0, limit)
			.map((row) => structuredClone(row));
	}
}

/** Separate instances per call; no process-wide mutable fake state. */
export function createInMemoryWorkflowCompilationRepositories(
	options: InMemoryWorkflowCompilationOptions = {},
) {
	return {
		compiledPlans: new InMemoryCompiledPlanRepository(options),
		rejections: new InMemoryWorkflowRejectionRepository(options),
	};
}
