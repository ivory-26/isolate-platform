import type {
	RunApproval,
	RunArtifact,
	RunAttempt,
	RunConnectorCall,
	RunEventView,
	RunJsonValue,
	RunTaskIdentity,
	RunToolInvocation,
} from "./contracts";
import { eventLabel } from "./view";

/**
 * Pure builder for the run execution map.
 *
 * The backend has no subagent model, so the tree is reconstructed only from
 * rows that exist: `task_attempts` (attempts), `agent.turn_started` /
 * `agent.turn_finished` events (turns), and the tool, connector, validation,
 * acceptance, approval and artifact rows already shown elsewhere on the run
 * page. Nothing is synthesized: a missing attempt, turn or child renders as an
 * explicit empty state in the component.
 *
 * Rules:
 * - Attempts are ordered by `attemptIndex`; a step belongs to the latest
 *   attempt whose window contains it, else the nearest preceding attempt.
 * - Turns are paired by `data.turn`, grouped by `data.agentId` when present,
 *   and fall back to one "Primary agent" group when delegation was not
 *   recorded.
 * - A step belongs to the latest turn that was running at its timestamp; a
 *   step outside every turn hangs directly off the attempt.
 */

export type ExecutionNodeKind =
	| "task"
	| "attempt"
	| "agent"
	| "turn"
	| "tool"
	| "connector"
	| "validation"
	| "acceptance"
	| "approval"
	| "artifact";

export type ExecutionNode = {
	/** Stable key for React and tests. */
	key: string;
	kind: ExecutionNodeKind;
	label: string;
	status: string | null;
	/** Short secondary text; already bounded and never a raw payload. */
	detail: string | null;
	durationMs: number | null;
	timestamp: string | null;
	finishedAt: string | null;
	children: ExecutionNode[];
};

export type ExecutionMap = {
	root: ExecutionNode;
	attemptCount: number;
	turnCount: number;
	stepCount: number;
	/** True when at least one turn event carried a `data.agentId`. */
	hasAgentId: boolean;
	/** False when no attempt row exists; the map then hangs off the task. */
	hasAttempts: boolean;
};

export type ExecutionMapSource = {
	task: Pick<RunTaskIdentity, "id" | "branch" | "status" | "repository">;
	attempts: readonly RunAttempt[];
	events: readonly RunEventView[];
	toolInvocations: readonly RunToolInvocation[];
	connectorCalls: readonly RunConnectorCall[];
	approvals: readonly RunApproval[];
	artifacts: readonly RunArtifact[];
};

type StepKind =
	| "tool"
	| "connector"
	| "validation"
	| "acceptance"
	| "approval"
	| "artifact";

type PendingStep = {
	key: string;
	kind: StepKind;
	label: string;
	status: string | null;
	detail: string | null;
	durationMs: number | null;
	timestamp: string | null;
	timeMs: number | null;
};

type Turn = {
	key: string;
	agentKey: string;
	agentLabel: string;
	hasAgentId: boolean;
	label: string;
	startedAt: string;
	finishedAt: string | null;
	startMs: number;
	endMs: number;
	/** Filled per attempt: the finish, the next turn's start, or the window end. */
	effectiveEndMs: number;
};

type AttemptBucket = {
	attempt: RunAttempt;
	startMs: number;
	endMs: number;
	turns: Turn[];
	steps: PendingStep[];
};

const PRIMARY_AGENT_KEY = "__primary__";
const PRIMARY_AGENT_LABEL = "Primary agent";
const STEP_KIND_ORDER: readonly StepKind[] = [
	"tool",
	"connector",
	"validation",
	"acceptance",
	"approval",
	"artifact",
];

function parseTime(value: string | null | undefined): number | null {
	if (typeof value !== "string" || value.length === 0) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function stringField(
	data: Record<string, RunJsonValue>,
	key: string,
	maxLength = 64,
): string | null {
	const value = data[key];
	if (typeof value !== "string" || value.length === 0) return null;
	return value.slice(0, maxLength);
}

function numberField(
	data: Record<string, RunJsonValue>,
	key: string,
): number | null {
	const value = data[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readAgentId(data: Record<string, RunJsonValue>): string | null {
	const value = data.agentId;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed.slice(0, 64);
}

function readTurnValue(data: Record<string, RunJsonValue>): string | null {
	const value = data.turn;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "string" && value.length > 0) return value.slice(0, 24);
	return null;
}

function stepKindForEvent(type: string): StepKind | null {
	if (type.startsWith("validation.")) return "validation";
	if (type.startsWith("acceptance.")) return "acceptance";
	return null;
}

function eventStatus(event: RunEventView): string | null {
	const stored = stringField(event.data, "status", 32);
	if (stored !== null) return stored;
	if (event.type.endsWith(".started")) return "started";
	if (event.type.endsWith(".finished")) return "finished";
	return null;
}

function compareSteps(left: PendingStep, right: PendingStep): number {
	const leftTime = left.timeMs ?? Number.POSITIVE_INFINITY;
	const rightTime = right.timeMs ?? Number.POSITIVE_INFINITY;
	if (leftTime !== rightTime) return leftTime - rightTime;
	const leftKind = STEP_KIND_ORDER.indexOf(left.kind);
	const rightKind = STEP_KIND_ORDER.indexOf(right.kind);
	if (leftKind !== rightKind) return leftKind - rightKind;
	return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function buildSteps(source: ExecutionMapSource): PendingStep[] {
	const steps: PendingStep[] = [];

	source.toolInvocations.forEach((tool, index) => {
		steps.push({
			key: `tool:${index}`,
			kind: "tool",
			label: tool.toolName,
			status: tool.decision,
			detail: tool.denialReason,
			durationMs: tool.durationMs,
			timestamp: tool.createdAt,
			timeMs: parseTime(tool.createdAt),
		});
	});

	source.connectorCalls.forEach((call, index) => {
		const detail =
			call.errorCode === null
				? call.connectorId
				: `${call.connectorId} · ${call.errorCode}`;
		steps.push({
			key: `connector:${index}`,
			kind: "connector",
			label: call.toolName,
			status: call.status,
			detail: detail.slice(0, 96),
			durationMs: null,
			timestamp: call.createdAt,
			timeMs: parseTime(call.createdAt),
		});
	});

	source.events.forEach((event, index) => {
		const kind = stepKindForEvent(event.type);
		if (kind === null) return;
		steps.push({
			key: `event:${index}`,
			kind,
			label: eventLabel(event.type),
			status: eventStatus(event),
			detail: stringField(event.data, "stage", 64),
			durationMs: numberField(event.data, "durationMs"),
			timestamp: event.createdAt,
			timeMs: parseTime(event.createdAt),
		});
	});

	source.approvals.forEach((approval, index) => {
		steps.push({
			key: `approval:${index}`,
			kind: "approval",
			label: approval.action,
			status: approval.status,
			detail: `requested by ${approval.requestedBy.slice(0, 48)}`,
			durationMs: null,
			timestamp: approval.createdAt,
			timeMs: parseTime(approval.createdAt),
		});
	});

	source.artifacts.forEach((artifact, index) => {
		steps.push({
			key: `artifact:${index}`,
			kind: "artifact",
			label: artifact.kind,
			status: null,
			detail: artifact.contentType,
			durationMs: null,
			timestamp: artifact.createdAt,
			timeMs: parseTime(artifact.createdAt),
		});
	});

	return steps.sort(compareSteps);
}

function buildTurns(events: readonly RunEventView[]): Turn[] {
	const turns: Turn[] = [];
	const open = new Map<string, Turn[]>();

	for (const event of events) {
		const isStart = event.type === "agent.turn_started";
		const isFinish = event.type === "agent.turn_finished";
		if (!isStart && !isFinish) continue;

		const agentId = readAgentId(event.data);
		const agentKey = agentId ?? PRIMARY_AGENT_KEY;
		const agentLabel = agentId ?? PRIMARY_AGENT_LABEL;
		const turnValue = readTurnValue(event.data);
		const openKey = `${agentKey}|${turnValue ?? ""}`;
		const timeMs = parseTime(event.createdAt);

		if (isStart) {
			const turn: Turn = {
				key: `turn:${turns.length}`,
				agentKey,
				agentLabel,
				hasAgentId: agentId !== null,
				label: turnValue === null ? "Agent turn" : `Turn ${turnValue}`,
				startedAt: event.createdAt,
				finishedAt: null,
				startMs: timeMs ?? Number.NEGATIVE_INFINITY,
				endMs: Number.POSITIVE_INFINITY,
				effectiveEndMs: Number.POSITIVE_INFINITY,
			};
			turns.push(turn);
			const stack = open.get(openKey);
			if (stack === undefined) open.set(openKey, [turn]);
			else stack.push(turn);
			continue;
		}

		const stack = open.get(openKey);
		const turn = stack?.pop();
		if (turn !== undefined) {
			turn.finishedAt = event.createdAt;
			turn.endMs = timeMs ?? Number.POSITIVE_INFINITY;
			continue;
		}
		// A finish without a start is still a real recorded event: show it as a
		// zero-length turn rather than inventing an earlier start.
		turns.push({
			key: `turn:${turns.length}`,
			agentKey,
			agentLabel,
			hasAgentId: agentId !== null,
			label: turnValue === null ? "Agent turn" : `Turn ${turnValue}`,
			startedAt: event.createdAt,
			finishedAt: event.createdAt,
			startMs: timeMs ?? Number.NEGATIVE_INFINITY,
			endMs: timeMs ?? Number.POSITIVE_INFINITY,
			effectiveEndMs: Number.POSITIVE_INFINITY,
		});
	}

	return turns;
}

function assignBucket(
	timeMs: number | null,
	buckets: readonly AttemptBucket[],
): AttemptBucket | null {
	if (buckets.length === 0) return null;
	if (timeMs === null) return buckets[0] ?? null;
	let preceding = buckets[0] ?? null;
	let containing: AttemptBucket | null = null;
	for (const bucket of buckets) {
		if (bucket.startMs <= timeMs) {
			preceding = bucket;
			if (timeMs <= bucket.endMs) containing = bucket;
		}
	}
	// Iterating in attempt order means the last containing bucket is the
	// latest-started one, which is the correct window when they overlap.
	return containing ?? preceding;
}

function sortTurns(turns: Turn[]): Turn[] {
	return turns.sort((left, right) => {
		if (left.startMs !== right.startMs) return left.startMs - right.startMs;
		return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
	});
}

function attachStepsToTurns(
	turns: readonly Turn[],
	steps: readonly PendingStep[],
): { childrenByTurn: Map<string, PendingStep[]>; direct: PendingStep[] } {
	const childrenByTurn = new Map<string, PendingStep[]>();
	const direct: PendingStep[] = [];
	for (const step of steps) {
		let match: Turn | null = null;
		if (step.timeMs !== null) {
			for (const turn of turns) {
				if (turn.startMs <= step.timeMs && step.timeMs <= turn.effectiveEndMs) {
					match = turn;
				}
			}
		}
		if (match === null) {
			direct.push(step);
			continue;
		}
		const children = childrenByTurn.get(match.key);
		if (children === undefined) childrenByTurn.set(match.key, [step]);
		else children.push(step);
	}
	return { childrenByTurn, direct };
}

function stepNode(step: PendingStep): ExecutionNode {
	return {
		key: step.key,
		kind: step.kind,
		label: step.label,
		status: step.status,
		detail: step.detail,
		durationMs: step.durationMs,
		timestamp: step.timestamp,
		finishedAt: null,
		children: [],
	};
}

function turnNode(turn: Turn, children: readonly PendingStep[]): ExecutionNode {
	return {
		key: turn.key,
		kind: "turn",
		label: turn.label,
		status: turn.finishedAt === null ? "running" : "finished",
		detail: null,
		durationMs: null,
		timestamp: turn.startedAt,
		finishedAt: turn.finishedAt,
		children: children.map(stepNode),
	};
}

function agentNodes(
	attemptKey: string,
	turns: readonly Turn[],
	childrenByTurn: Map<string, PendingStep[]>,
): ExecutionNode[] {
	const groups = new Map<string, { label: string; turns: Turn[] }>();
	for (const turn of turns) {
		const group = groups.get(turn.agentKey);
		if (group === undefined) {
			groups.set(turn.agentKey, { label: turn.agentLabel, turns: [turn] });
		} else {
			group.turns.push(turn);
		}
	}
	return [...groups.entries()].map(([agentKey, group]) => ({
		key: `${attemptKey}:agent:${agentKey}`,
		kind: "agent" as const,
		label: group.label,
		status: null,
		detail: `${group.turns.length} turn${group.turns.length === 1 ? "" : "s"}`,
		durationMs: null,
		timestamp: group.turns[0]?.startedAt ?? null,
		finishedAt: null,
		children: group.turns.map((turn) =>
			turnNode(turn, childrenByTurn.get(turn.key) ?? []),
		),
	}));
}

function attemptNode(bucket: AttemptBucket): ExecutionNode {
	const turns = sortTurns(bucket.turns);
	for (let index = 0; index < turns.length; index += 1) {
		const turn = turns[index];
		if (turn === undefined) continue;
		const next = turns[index + 1];
		if (turn.endMs !== Number.POSITIVE_INFINITY) {
			turn.effectiveEndMs = turn.endMs;
		} else if (next !== undefined) {
			turn.effectiveEndMs = next.startMs;
		} else {
			turn.effectiveEndMs = bucket.endMs;
		}
	}
	const { childrenByTurn, direct } = attachStepsToTurns(turns, bucket.steps);
	const key = `attempt:${bucket.attempt.attemptIndex}`;
	return {
		key,
		kind: "attempt",
		label: `Attempt ${bucket.attempt.attemptIndex}`,
		status: bucket.attempt.status,
		detail: bucket.attempt.errorCode,
		durationMs: null,
		timestamp: bucket.attempt.startedAt,
		finishedAt: bucket.attempt.finishedAt,
		children: [
			...agentNodes(key, turns, childrenByTurn),
			...direct.map(stepNode),
		],
	};
}

function rootNodeWithAttempts(
	source: ExecutionMapSource,
	buckets: AttemptBucket[],
): ExecutionNode {
	return {
		key: "task",
		kind: "task",
		label: source.task.id,
		status: source.task.status,
		detail: `${source.task.repository.fullName} · ${source.task.branch}`,
		durationMs: null,
		timestamp: null,
		finishedAt: null,
		children: buckets.map(attemptNode),
	};
}

function rootNodeWithoutAttempts(
	source: ExecutionMapSource,
	turns: readonly Turn[],
	steps: readonly PendingStep[],
): ExecutionNode {
	const sortedTurns = sortTurns([...turns]);
	for (let index = 0; index < sortedTurns.length; index += 1) {
		const turn = sortedTurns[index];
		if (turn === undefined) continue;
		const next = sortedTurns[index + 1];
		if (turn.endMs !== Number.POSITIVE_INFINITY) {
			turn.effectiveEndMs = turn.endMs;
		} else if (next !== undefined) {
			turn.effectiveEndMs = next.startMs;
		} else {
			turn.effectiveEndMs = Number.POSITIVE_INFINITY;
		}
	}
	const { childrenByTurn, direct } = attachStepsToTurns(sortedTurns, steps);
	return {
		key: "task",
		kind: "task",
		label: source.task.id,
		status: source.task.status,
		detail: `${source.task.repository.fullName} · ${source.task.branch}`,
		durationMs: null,
		timestamp: null,
		finishedAt: null,
		children: [
			...agentNodes("task", sortedTurns, childrenByTurn),
			...direct.map(stepNode),
		],
	};
}

/** Builds the execution tree; the source is never mutated. */
export function buildExecutionMap(source: ExecutionMapSource): ExecutionMap {
	const attempts = [...source.attempts].sort(
		(left, right) => left.attemptIndex - right.attemptIndex,
	);
	const steps = buildSteps(source);
	const turns = buildTurns(source.events);

	const buckets: AttemptBucket[] = attempts.map((attempt) => ({
		attempt,
		startMs: parseTime(attempt.startedAt) ?? Number.NEGATIVE_INFINITY,
		endMs: parseTime(attempt.finishedAt) ?? Number.POSITIVE_INFINITY,
		turns: [],
		steps: [],
	}));

	for (const step of steps) {
		const bucket = assignBucket(step.timeMs, buckets);
		bucket?.steps.push(step);
	}
	for (const turn of turns) {
		const bucket = assignBucket(turn.startMs, buckets);
		bucket?.turns.push(turn);
	}

	const root =
		buckets.length === 0
			? rootNodeWithoutAttempts(source, turns, steps)
			: rootNodeWithAttempts(source, buckets);

	return {
		root,
		attemptCount: attempts.length,
		turnCount: turns.length,
		stepCount: steps.length,
		hasAgentId: turns.some((turn) => turn.hasAgentId),
		hasAttempts: attempts.length > 0,
	};
}
