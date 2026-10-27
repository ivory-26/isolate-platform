import { describe, expect, test } from "bun:test";
import {
	createRunEvent,
	parseRunEvent,
	RUN_EVENT_TYPES,
	runEventEnvelopeSchema,
	runEventSchema,
} from "./events";

describe("runEventEnvelopeSchema", () => {
	test("parses a bare envelope and defaults data to {}", () => {
		const parsed = runEventEnvelopeSchema.parse({
			taskId: "task_1",
			workflowRunId: null,
			type: "task.enqueued",
			actor: "agent",
		});
		expect(parsed.data).toEqual({});
	});

	test("rejects unknown types and actors", () => {
		expect(
			runEventEnvelopeSchema.safeParse({
				taskId: "task_1",
				workflowRunId: null,
				type: "task.teleported",
				actor: "agent",
			}).success,
		).toBe(false);
		expect(
			runEventEnvelopeSchema.safeParse({
				taskId: "task_1",
				workflowRunId: null,
				type: RUN_EVENT_TYPES[0],
				actor: "wizard",
			}).success,
		).toBe(false);
	});
});

describe("runEventSchema", () => {
	test("parses a full persisted event", () => {
		const parsed = runEventSchema.parse({
			id: "evt_1",
			taskId: "task_1",
			workflowRunId: "run_1",
			type: "tool.invoked",
			actor: "agent",
			data: { tool: "git.diff" },
			occurredAt: new Date().toISOString(),
		});
		expect(parsed.type).toBe("tool.invoked");
		expect(parsed.data).toEqual({ tool: "git.diff" });
	});

	test("rejects unparseable timestamps", () => {
		expect(
			runEventSchema.safeParse({
				id: "evt_1",
				taskId: "task_1",
				workflowRunId: null,
				type: "tool.invoked",
				actor: "agent",
				occurredAt: "not-a-date",
			}).success,
		).toBe(false);
	});

	test("parseRunEvent reports failures as VALIDATION_FAILED results", () => {
		const result = parseRunEvent({
			id: "evt_1",
			taskId: "task_1",
			type: "task.enqueued",
			actor: "agent",
			occurredAt: new Date().toISOString(),
		});
		// missing workflowRunId (non-optional) must fail:
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("VALIDATION_FAILED");
		}
	});
});

describe("createRunEvent", () => {
	test("stamps id and occurredAt defaults", () => {
		const event = createRunEvent({
			taskId: "task_1",
			workflowRunId: null,
			type: "task.claimed",
			actor: "worker",
		});
		expect(event.id.startsWith("evt_")).toBe(true);
		expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
		expect(event.data).toEqual({});
	});

	test("keeps caller-supplied identity and payload", () => {
		const event = createRunEvent({
			id: "evt_fixed",
			taskId: "task_1",
			workflowRunId: "run_1",
			type: "approval.requested",
			actor: "policy",
			data: { approvalId: "approval_1" },
			occurredAt: "2026-01-01T00:00:00.000Z",
		});
		expect(event.id).toBe("evt_fixed");
		expect(event.occurredAt).toBe("2026-01-01T00:00:00.000Z");
		expect(event.data).toEqual({ approvalId: "approval_1" });
	});
});
