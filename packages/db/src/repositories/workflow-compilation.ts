import { types } from "node:util";
import type { OrganizationId, WorkflowDefinitionId } from "@isolate/shared";
import type { CompiledWorkflowPlan, WorkflowRejectionIssue } from "../schema";
import { requireNonEmpty, requirePositiveInt } from "./task-repository";

/** A registered authored version, also used to seed offline FK equivalents. */
export type WorkflowVersionPin = {
	organizationId: OrganizationId;
	workflowDefinitionId: WorkflowDefinitionId;
	workflowVersion: number;
};

export function validateWorkflowScope(
	organizationId: OrganizationId,
	workflowDefinitionId: WorkflowDefinitionId,
): void {
	requireNonEmpty(organizationId, "organizationId");
	requireNonEmpty(workflowDefinitionId, "workflowDefinitionId");
}

export function validateWorkflowPin(input: WorkflowVersionPin): void {
	validateWorkflowScope(input.organizationId, input.workflowDefinitionId);
	requirePositiveInt(input.workflowVersion, "workflowVersion");
	if (input.workflowVersion > 2147483647)
		throw new Error("workflowVersion must fit a PostgreSQL integer");
}

export function sameWorkflowPin(
	a: WorkflowVersionPin,
	b: WorkflowVersionPin,
): boolean {
	return (
		a.organizationId === b.organizationId &&
		a.workflowDefinitionId === b.workflowDefinitionId &&
		a.workflowVersion === b.workflowVersion
	);
}

export function evaluateWorkflowVersion(
	versionExists: boolean,
): { ok: true } | { ok: false; code: "NOT_FOUND" } {
	return versionExists ? { ok: true } : { ok: false, code: "NOT_FOUND" };
}

/** This lookup never reveals a foreign tenant's version. */
export const WORKFLOW_VERSION_EXISTS_SQL = `SELECT v.id FROM workflow_versions v
	JOIN workflow_definitions d ON d.id = v.definition_id
	WHERE d.organization_id = $1 AND d.id = $2 AND v.version = $3`;

type WorkflowJson =
	| null
	| boolean
	| number
	| string
	| WorkflowJson[]
	| { [key: string]: WorkflowJson };

function validateJsonbString(value: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 0)
			throw new Error("workflow payload JSON must not contain NUL");
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new Error(
					"workflow payload JSON must not contain unpaired surrogates",
				);
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new Error(
				"workflow payload JSON must not contain unpaired surrogates",
			);
		}
	}
}

/** Read descriptors, never values through caller getters/iterators/toJSON. */
function snapshotWorkflowJson(value: unknown): WorkflowJson {
	const ancestors = new Set<object>();
	function copy(item: unknown): WorkflowJson {
		if (item === null || typeof item === "boolean") return item;
		if (typeof item === "string") {
			validateJsonbString(item);
			return item;
		}
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (typeof item !== "object" || item === null) {
			throw new Error("workflow payload must contain only JSON values");
		}
		// Proxy descriptor/prototype traps can execute code just like getters.
		if (types.isProxy(item))
			throw new Error("workflow payload must not contain proxies");
		if (ancestors.has(item))
			throw new Error("workflow payload must not be cyclic");
		const array = Array.isArray(item);
		const prototype = Object.getPrototypeOf(item);
		if (
			prototype !== null &&
			prototype !== (array ? Array.prototype : Object.prototype)
		) {
			throw new Error(
				"workflow payload must contain only plain JSON objects and arrays",
			);
		}
		const descriptors = Object.getOwnPropertyDescriptors(item);
		const keys = Reflect.ownKeys(descriptors);
		const length = array ? (descriptors.length.value as number) : 0;
		if (array && keys.length !== length + 1) {
			throw new Error(
				"workflow payload arrays must be dense without extra properties",
			);
		}
		const snapshot: WorkflowJson[] | { [key: string]: WorkflowJson } = array
			? []
			: Object.create(null);
		// Detached arrays must not inherit a serialization hook either.
		if (array) Object.setPrototypeOf(snapshot, null);
		ancestors.add(item);
		for (const key of keys) {
			if (typeof key !== "string")
				throw new Error("workflow payload must not contain symbol keys");
			validateJsonbString(key);
			const descriptor = descriptors[key];
			if (!("value" in descriptor))
				throw new Error("workflow payload must not contain accessors");
			if (array && key === "length") continue;
			if (!descriptor.enumerable)
				throw new Error("workflow payload must not contain hidden properties");
			const index = Number(key);
			if (
				array &&
				(!Number.isInteger(index) ||
					index < 0 ||
					index >= length ||
					String(index) !== key)
			) {
				throw new Error(
					"workflow payload arrays must not contain extra properties",
				);
			}
			Object.defineProperty(snapshot, key, {
				value: copy(descriptor.value),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		ancestors.delete(item);
		return snapshot;
	}
	return copy(value);
}

/** Reject lossy/non-jsonb input and stringify only a detached, hook-free copy. */
export function serializeWorkflowJson(value: unknown): string {
	return JSON.stringify(snapshotWorkflowJson(value));
}

function snapshotWorkflowInput<T extends WorkflowVersionPin>(input: T): T {
	// Preserve the version-specific error for non-JSON numbers without reading
	// through an accessor or letting a proxy run a descriptor trap.
	if (input !== null && typeof input === "object" && !types.isProxy(input)) {
		const version = Object.getOwnPropertyDescriptor(input, "workflowVersion");
		if (version && "value" in version)
			requirePositiveInt(version.value, "workflowVersion");
	}
	const snapshot = snapshotWorkflowJson(input);
	if (
		snapshot === null ||
		typeof snapshot !== "object" ||
		Array.isArray(snapshot)
	) {
		throw new Error("workflow payload input must be a JSON object");
	}
	return snapshot as unknown as T;
}

export function validateCompiledPlan(
	input: WorkflowVersionPin & { plan: CompiledWorkflowPlan },
): string {
	const snapshot = snapshotWorkflowInput(input);
	validateWorkflowPin(snapshot);
	const plan = snapshot.plan;
	if (!plan || typeof plan !== "object" || Array.isArray(plan))
		throw new Error("plan must be a compiled workflow object");
	if (
		plan.workflowId !== snapshot.workflowDefinitionId ||
		plan.versionPinned !== snapshot.workflowVersion
	) {
		throw new Error(
			"plan workflowId/versionPinned must match the workflow pin",
		);
	}
	requireNonEmpty(plan.planId, "plan.planId");
	if (
		!Array.isArray(plan.entryNodeIds) ||
		!Array.isArray(plan.steps) ||
		!Array.isArray(plan.edges)
	) {
		throw new Error("plan must contain entryNodeIds, steps and edges arrays");
	}
	for (let index = 0; index < plan.entryNodeIds.length; index++) {
		if (typeof plan.entryNodeIds[index] !== "string")
			throw new Error("plan.entryNodeIds must contain strings");
	}
	return JSON.stringify(plan);
}

export function validateRejectionIssues(
	input: WorkflowVersionPin & { issues: WorkflowRejectionIssue[] },
): string {
	const snapshot = snapshotWorkflowInput(input);
	validateWorkflowPin(snapshot);
	const issues = snapshot.issues;
	if (!Array.isArray(issues) || issues.length === 0)
		throw new Error("issues must be a non-empty array");
	for (let index = 0; index < issues.length; index++) {
		const issue = issues[index];
		if (!issue || typeof issue !== "object" || typeof issue.path !== "string")
			throw new Error("each issue must have a string path");
		requireNonEmpty(issue.code, "issue.code");
		requireNonEmpty(issue.message, "issue.message");
	}
	return JSON.stringify(issues);
}

export function validateRejectionLimit(limit: number): void {
	requirePositiveInt(limit, "limit");
	if (limit > 500) throw new Error("limit must be at most 500");
}
