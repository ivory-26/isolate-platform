import { createServerFn } from "@tanstack/react-start";
import { readRunDetail, readRunsList } from "../../server/runs-read.server";
import { uiRead } from "../../server/ui-runtime.server";
import type { UiResult } from "../ui/contracts";
import type {
	RunDetailInput,
	RunDetailView,
	RunsListInput,
	RunsListPage,
} from "./contracts";

/**
 * Server functions for the Runs surfaces (wave 20).
 *
 * Both reads go through `uiRead`, which resolves the trusted caller scope,
 * requires `task:read` (every role, including viewer, holds it) BEFORE any
 * storage read, binds `scope.organizationId` as the only tenancy input and
 * answers `Cache-Control: private, no-store`. Failures collapse to bounded
 * `UiResult` codes; no driver message, payload or request value escapes.
 *
 * The read model re-validates every input (UUID, enum, bounds) before SQL, so
 * the client validator here is only a typing seam. Write actions are
 * deliberately NOT duplicated: retry and approval decisions call the existing
 * task service functions, which check `task:submit` on the server.
 */

export const listRuns = createServerFn({ method: "GET" })
	.validator((input: RunsListInput) => input)
	.handler(async ({ data }): Promise<UiResult<RunsListPage>> => {
		return uiRead<RunsListPage>("task:read", (scope, sql) =>
			readRunsList(sql, scope, data),
		);
	});

export const getRunDetail = createServerFn({ method: "GET" })
	.validator((input: RunDetailInput) => input)
	.handler(async ({ data }): Promise<UiResult<RunDetailView>> => {
		return uiRead<RunDetailView>("task:read", (scope, sql) =>
			readRunDetail(sql, scope, data),
		);
	});
