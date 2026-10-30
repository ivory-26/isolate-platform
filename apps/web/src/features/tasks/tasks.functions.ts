import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getTaskService } from "../../server/runtime.server";
import {
	type DecideApprovalInput,
	decideApprovalSchema,
	listTasksSchema,
	type RetryTaskInput,
	retryTaskSchema,
	type SubmitTaskInput,
	submitTaskSchema,
} from "./contracts";

export const submitTask = createServerFn({ method: "POST" })
	.validator((input: SubmitTaskInput) => {
		const parsed = submitTaskSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid task request.");
		return parsed.data;
	})
	.handler(async ({ data }) => {
		setResponseHeader("Cache-Control", "private, no-store");
		return getTaskService().submit(data);
	});
export const listTasks = createServerFn({ method: "GET" })
	.validator((input: { limit?: number }) => {
		const parsed = listTasksSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid list request.");
		return parsed.data;
	})
	.handler(async ({ data }) => {
		setResponseHeader("Cache-Control", "private, no-store");
		return getTaskService().list(data);
	});
/**
 * Server-side rerun action (wave 8). No route or page is added: a later wave
 * only needs to call this from a button.
 */
export const retryTask = createServerFn({ method: "POST" })
	.validator((input: RetryTaskInput) => {
		const parsed = retryTaskSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid retry request.");
		return parsed.data;
	})
	.handler(async ({ data }) => {
		setResponseHeader("Cache-Control", "private, no-store");
		return getTaskService().retry(data);
	});
/**
 * Server-side approval decision (wave 8). Approval enqueues exactly one
 * follow-up job; rejection fails the task and enqueues nothing.
 */
export const decideApproval = createServerFn({ method: "POST" })
	.validator((input: DecideApprovalInput) => {
		const parsed = decideApprovalSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid approval decision request.");
		return parsed.data;
	})
	.handler(async ({ data }) => {
		setResponseHeader("Cache-Control", "private, no-store");
		return getTaskService().decideApproval(data);
	});
