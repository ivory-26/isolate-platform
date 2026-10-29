import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getTaskService } from "../../server/runtime.server";
import {
	listTasksSchema,
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
