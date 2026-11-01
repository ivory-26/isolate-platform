import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
	readWorkspaceMembers,
	readWorkspaceSummary,
} from "../../server/settings-read.server";
import { uiRead } from "../../server/ui-runtime.server";
import type { WorkspaceMember, WorkspaceSummary } from "./contracts";

/**
 * Settings read models. Capability checks happen inside `uiRead` before any
 * storage is touched, and every answer is `private, no-store`.
 */
export const getWorkspaceSummary = createServerFn({ method: "GET" }).handler(
	async () => {
		setResponseHeader("Cache-Control", "private, no-store");
		return uiRead<WorkspaceSummary>("organization:read", readWorkspaceSummary);
	},
);

/**
 * Member emails are limited to the capability that governs membership. Members
 * and viewers get a fixed refusal instead of another tenant's data.
 */
export const getWorkspaceMembers = createServerFn({ method: "GET" }).handler(
	async () => {
		setResponseHeader("Cache-Control", "private, no-store");
		return uiRead<WorkspaceMember[]>("member:manage", readWorkspaceMembers);
	},
);
