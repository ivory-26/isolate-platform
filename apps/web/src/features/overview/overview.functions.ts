import { createServerFn } from "@tanstack/react-start";
import {
	readOverviewSnapshot,
	readSubmitOptions,
} from "../../server/overview-read.server";

/**
 * Overview and Submit-option reads. Both delegate to `uiRead("task:read")`,
 * which sets `private, no-store` and binds the caller's organization.
 */
export const getOverview = createServerFn({ method: "GET" }).handler(async () =>
	readOverviewSnapshot(),
);

export const getSubmitOptions = createServerFn({ method: "GET" }).handler(
	async () => readSubmitOptions(),
);
