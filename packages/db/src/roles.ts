import type { UserRole } from "./schema";

/**
 * Capabilities derived from the tenant role (ARCHITECTURE.md §5). The role
 * stored on the membership is the only authorization input; request data can
 * never widen it.
 */
export const PLATFORM_CAPABILITIES = [
	"task:read",
	"task:submit",
	"organization:read",
	"member:manage",
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<UserRole, readonly PlatformCapability[]> = {
	owner: ["task:read", "task:submit", "organization:read", "member:manage"],
	admin: ["task:read", "task:submit", "organization:read", "member:manage"],
	member: ["task:read", "task:submit", "organization:read"],
	viewer: ["task:read", "organization:read"],
};

export function capabilitiesFor(role: UserRole): readonly PlatformCapability[] {
	return ROLE_CAPABILITIES[role];
}

export function hasCapability(
	role: UserRole,
	capability: PlatformCapability,
): boolean {
	return ROLE_CAPABILITIES[role].includes(capability);
}
