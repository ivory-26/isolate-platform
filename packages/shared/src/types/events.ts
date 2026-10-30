import { z } from "zod";
import type { PlatformError } from "./errors";
import { newId } from "./ids";
import type { Result } from "./result";
import { parseWith } from "./zod";

/**
 * Append-only event vocabulary for run timelines and audit trails.
 * Every agent turn, tool call, workflow step, and approval action emits exactly
 * one of these; `data` payload shapes are declared per type by consumers.
 */
export const RUN_EVENT_TYPES = [
	"task.enqueued",
	"task.claimed",
	"task.state_changed",
	"workspace.cloned",
	"artifact.created",
	"agent.turn_started",
	"agent.turn_finished",
	"tool.invoked",
	"tool.denied_by_policy",
	"workflow.step_started",
	"workflow.step_finished",
	"workflow.step_failed",
	"validation.started",
	"validation.finished",
	"repair.started",
	"repair.finished",
	"approval.requested",
	"approval.decided",
	"pr.created",
	"worker.lease_renewed",
	"worker.job_failed",
	"worker.job_dead_lettered",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const runEventTypeSchema = z.enum(RUN_EVENT_TYPES);

/** Actor kinds for attribution; never store raw credentials here. */
export const EVENT_ACTORS = [
	"user",
	"agent",
	"worker",
	"system",
	"policy",
] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

/**
 * A persisted event row. `data` is a JSON object whose shape depends on
 * `type`; consumers validate with schemas before trusting it.
 */
export type RunEvent<TData = unknown> = {
	id: string;
	taskId: string;
	workflowRunId: string | null;
	type: RunEventType;
	actor: EventActor;
	data: TData;
	occurredAt: string;
};

/**
 * The wire envelope for emitting an event (before the repository stamps
 * identity fields). Kept verbatim as the pre-existing contract surface.
 */
export const runEventEnvelopeSchema = z.object({
	taskId: z.string().min(1),
	workflowRunId: z.string().nullable(),
	type: runEventTypeSchema,
	actor: z.enum(EVENT_ACTORS),
	data: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Full persisted-event schema: the envelope plus the row identity fields the
 * repository stamps (`id`, `occurredAt`). `occurredAt` must parse as a
 * timestamp; precision/format beyond that is left to the storage layer.
 */
export const runEventSchema = z.object({
	id: z.string().min(1),
	taskId: z.string().min(1),
	workflowRunId: z.string().nullable(),
	type: runEventTypeSchema,
	actor: z.enum(EVENT_ACTORS),
	data: z.record(z.string(), z.unknown()).default({}),
	occurredAt: z
		.string()
		.min(1)
		.refine((value) => !Number.isNaN(Date.parse(value)), {
			message: "occurredAt must be a parseable ISO-8601 timestamp",
		}),
});

export type ParsedRunEvent = z.infer<typeof runEventSchema>;

export function parseRunEvent(
	input: unknown,
): Result<ParsedRunEvent, PlatformError> {
	return parseWith(runEventSchema, input);
}

/**
 * Builds a well-formed event, stamping server-generated `id` and `occurredAt`
 * when the caller does not supply them. Payloads are the caller's
 * responsibility: run them through `redactDeep` before persisting/log line
 * emission if they embed untrusted content.
 */
export type CreateRunEventInput = Pick<
	ParsedRunEvent,
	"taskId" | "workflowRunId" | "type" | "actor"
> &
	Partial<Pick<ParsedRunEvent, "data" | "id" | "occurredAt">>;

export function createRunEvent(input: CreateRunEventInput): ParsedRunEvent {
	return {
		id: input.id ?? newId("evt"),
		taskId: input.taskId,
		workflowRunId: input.workflowRunId,
		type: input.type,
		actor: input.actor,
		data: input.data ?? {},
		occurredAt: input.occurredAt ?? new Date().toISOString(),
	};
}
