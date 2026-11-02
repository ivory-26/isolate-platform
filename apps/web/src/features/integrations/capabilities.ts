import type { PlatformCapability } from "@isolate/db";

/**
 * Connector capabilities are part of the wave-23 contract
 * (`connector:read` / `connector:manage`, docs/connector-onboarding.md §3).
 *
 * `packages/db/src/roles.ts` still exposes only the wave-1 capability set, so
 * this module is the single seam that maps the documented connector tokens onto
 * the implemented role capabilities:
 *
 *   connector:read   -> task:read      (every role, including viewer)
 *   connector:manage -> member:manage  (owner and admin only)
 *
 * When the database role table gains the connector tokens, change this map to
 * the identity mapping. Nothing else in the web layer hard-codes a capability.
 */
export const CONNECTOR_CAPABILITY = {
	read: "connector:read",
	manage: "connector:manage",
} as const;

export type ConnectorCapability =
	(typeof CONNECTOR_CAPABILITY)[keyof typeof CONNECTOR_CAPABILITY];

export const CONNECTOR_CAPABILITY_PLATFORM_MAP: Readonly<
	Record<ConnectorCapability, PlatformCapability>
> = {
	[CONNECTOR_CAPABILITY.read]: "task:read",
	[CONNECTOR_CAPABILITY.manage]: "member:manage",
};

/** The platform capability that currently enforces a connector capability. */
export function platformCapabilityFor(
	capability: ConnectorCapability,
): PlatformCapability {
	return CONNECTOR_CAPABILITY_PLATFORM_MAP[capability];
}
