import { createServerFn } from "@tanstack/react-start";
import { uiRead } from "../../server/ui-runtime.server";
import { readUsage } from "../../server/usage-read.server";
import type { UiResult } from "../ui/contracts";
import { type UsageReadModel, usageRequestSchema } from "./contracts";

/**
 * Measured usage read. The period is enumerated server-side and the window is
 * resolved in UTC on the server; `uiRead` adds `private, no-store` and maps
 * every failure to a fixed code.
 */
export const getUsage = createServerFn({ method: "GET" })
	.validator((input: unknown) => {
		const parsed = usageRequestSchema.safeParse(input);
		if (!parsed.success) throw new Error("Invalid usage request.");
		return parsed.data;
	})
	.handler(
		async ({ data }): Promise<UiResult<UsageReadModel>> =>
			uiRead("task:read", (scope, sql) =>
				readUsage(sql, scope.organizationId, data.period),
			),
	);
