import { createServerFn } from "@tanstack/react-start";
import { uiRead } from "../../server/ui-runtime.server";
import type { UiResult } from "../ui/contracts";
import type { SetupState } from "./contracts";
import { readSetupState } from "./onboarding-read.server";

/**
 * Setup state for the wizard, the Home checklist and the first-sign-in gate.
 * Every role can read it; it contains booleans and one connector id only.
 */
export const getSetupState = createServerFn({ method: "GET" }).handler(
	async (): Promise<UiResult<SetupState>> =>
		uiRead("organization:read", async (scope, sql) =>
			readSetupState(sql, scope.organizationId),
		),
);
