import { createServerFn } from "@tanstack/react-start";
import { readWorkflows } from "../../server/catalog-read.server";
import { uiRead } from "../../server/ui-runtime.server";
import type { UiResult } from "../ui/contracts";
import type { WorkflowsReadModel } from "./contracts";

/**
 * Read-only workflow library. The visual builder is a later wave, so this
 * surface exposes definitions, immutable versions and validation state only —
 * no create, edit or publish action exists here.
 */
export const listWorkflows = createServerFn({ method: "GET" }).handler(
	async (): Promise<UiResult<WorkflowsReadModel>> =>
		uiRead("task:read", async (scope, sql) =>
			readWorkflows(sql, scope.organizationId),
		),
);
