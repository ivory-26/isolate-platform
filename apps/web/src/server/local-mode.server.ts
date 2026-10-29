import "@tanstack/react-start/server-only";
import { asOrganizationId, asUserId } from "@isolate/shared";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

export const localDemo = {
	organizationId: asOrganizationId("10000000-0000-4000-8000-000000000001"),
	userId: asUserId("10000000-0000-4000-8000-000000000002"),
	repositoryId: "10000000-0000-4000-8000-000000000003",
} as const;
export type RuntimeConfig = {
	nodeEnv?: string;
	localDemo?: string;
	databaseUrl?: string;
};
export function resolveLocalScope(config: RuntimeConfig): CallerScope {
	// This is NOT authentication. Never point an unauthenticated demo at a DB.
	if (
		(config.nodeEnv !== "development" && config.nodeEnv !== "test") ||
		config.localDemo !== "true" ||
		config.databaseUrl
	)
		throw new ControlPlaneError("AUTH_REQUIRED");
	return { organizationId: localDemo.organizationId, userId: localDemo.userId };
}
