import { createServerFn } from "@tanstack/react-start";
import {
	readHomeSnapshot,
	readSubmitOptions,
} from "../../server/overview-read.server";

/**
 * Home and delegate-option reads. Both delegate to `uiRead("task:read")`,
 * which sets `private, no-store` and binds the caller's organization.
 */
export const getOverview = createServerFn({ method: "GET" }).handler(async () =>
	readHomeSnapshot(),
);

export const getSubmitOptions = createServerFn({ method: "GET" }).handler(
	async () => readSubmitOptions(),
);
