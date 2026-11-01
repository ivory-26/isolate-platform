import { createServerFn } from "@tanstack/react-start";
import { readApprovalsSnapshot } from "../../server/approvals-read.server";

/** Tenant-scoped approvals snapshot; capability and no-store come from uiRead. */
export const getApprovals = createServerFn({ method: "GET" }).handler(
	async () => readApprovalsSnapshot(),
);
