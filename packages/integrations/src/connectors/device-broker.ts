import {
	type ConnectorCredentialSummary,
	type ConnectorDeviceSummary,
	connectorCredentialRefSchema,
	connectorIdSchema,
	type OrganizationId,
	PlatformError,
} from "@isolate/shared";
import type {
	DeviceProxy,
	DeviceProxyFactory,
	DeviceProxyTarget,
} from "./device-proxy";

/**
 * Device broker: resolves which user device executes a connector call.
 *
 * For `(organizationId, connectorId)` it requires an active device and an
 * active credential row on that device, then asks the injected factory for the
 * transport. It returns only `{ deviceId, credentialId, credentialRef, scopes,
 * metadata, proxy }`; the secret is never fetched, decrypted or serialized
 * here because the server does not have it. `deviceId`/`credentialId` are the
 * queue routing identities; they are opaque and never a secret.
 *
 * `allowEnvFallback` is opt-in and single-tenant only: a caller-supplied lookup
 * may name a `credential_ref` for a bridge deployment, but it can never supply
 * a value. A missing, revoked, cross-tenant or device-less row fails closed as
 * `INTEGRATION_UNAVAILABLE`.
 */

/**
 * Narrow structural views so the integrations package does not import the
 * database package. The Postgres repositories and in-memory fakes satisfy
 * these structurally.
 */
export interface ConnectorDeviceReader {
	listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorDeviceSummary[]>;
}

export interface ConnectorCredentialReader {
	listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorCredentialSummary[]>;
}

export type ConnectorEnvCredentialRefLookup = (
	connectorId: string,
) => string | null | undefined | Promise<string | null | undefined>;

export type ConnectorDeviceBrokerOptions = {
	devices: ConnectorDeviceReader;
	credentials: ConnectorCredentialReader;
	proxyFactory: DeviceProxyFactory;
	/** Never defaulted to true; single-tenant bridges must opt in. */
	allowEnvFallback?: boolean;
	credentialRefLookup?: ConnectorEnvCredentialRefLookup;
};

export type ResolvedConnectorDevice = {
	/**
	 * Device that owns the credential and polls the call queue. `null` only for
	 * the single-tenant env fallback, which has no device row and therefore no
	 * poll queue: a queue-backed caller must fail closed.
	 */
	readonly deviceId: string | null;
	/** Credential row identity used by the device to select its keychain item. */
	readonly credentialId: string | null;
	/** Opaque device-side keychain item name, never a secret. */
	readonly credentialRef: string;
	readonly scopes: readonly string[];
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly proxy: DeviceProxy;
};

export interface ConnectorDeviceBroker {
	resolve(
		organizationId: OrganizationId,
		connectorId: string,
	): Promise<ResolvedConnectorDevice>;
}

function unavailable(connectorId: string, reason: string): PlatformError {
	return new PlatformError(
		"INTEGRATION_UNAVAILABLE",
		`connector "${connectorId}" ${reason}`,
	);
}

function requireOrganizationId(value: unknown): OrganizationId {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new PlatformError("VALIDATION_FAILED", "organizationId is required");
	}
	return value as OrganizationId;
}

function requireConnectorId(value: unknown): string {
	const parsed = connectorIdSchema.safeParse(value);
	if (!parsed.success) {
		throw new PlatformError("VALIDATION_FAILED", "connectorId is invalid");
	}
	return parsed.data;
}

/**
 * Deterministic pick when a connector has more than one active row: display
 * name, then id. The service is expected to keep one active row per connector;
 * the ordering only removes run-to-run nondeterminism.
 */
function selectActiveCredential(
	rows: readonly ConnectorCredentialSummary[],
	organizationId: OrganizationId,
	connectorId: string,
	activeDeviceIds: ReadonlySet<string>,
): ConnectorCredentialSummary | null {
	const candidates = rows
		.filter(
			(row) =>
				row.organizationId === organizationId &&
				row.connectorId === connectorId &&
				row.status === "active" &&
				activeDeviceIds.has(row.deviceId),
		)
		.sort((left, right) => {
			const byName = left.displayName.localeCompare(right.displayName);
			return byName !== 0 ? byName : left.id.localeCompare(right.id);
		});
	return candidates[0] ?? null;
}

export function createConnectorDeviceBroker(
	options: ConnectorDeviceBrokerOptions,
): ConnectorDeviceBroker {
	const allowEnvFallback = options.allowEnvFallback === true;
	if (typeof options.proxyFactory !== "function") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"device proxy factory is required",
		);
	}
	if (allowEnvFallback && typeof options.credentialRefLookup !== "function") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"env credential ref fallback requires a lookup function",
		);
	}

	const buildProxy = async (
		target: DeviceProxyTarget,
	): Promise<DeviceProxy> => {
		let proxy: DeviceProxy | null;
		try {
			proxy = await options.proxyFactory(target);
		} catch {
			throw unavailable(target.connectorId, "device proxy is unavailable");
		}
		if (proxy === null || proxy === undefined) {
			throw unavailable(target.connectorId, "device proxy is unavailable");
		}
		return proxy;
	};

	const resolveFallback = async (
		organizationId: OrganizationId,
		connectorId: string,
	): Promise<ResolvedConnectorDevice> => {
		if (!allowEnvFallback || options.credentialRefLookup === undefined) {
			throw unavailable(connectorId, "has no active device credential");
		}
		let candidate: string | null | undefined;
		try {
			candidate = await options.credentialRefLookup(connectorId);
		} catch {
			throw unavailable(connectorId, "has no active device credential");
		}
		if (candidate === null || candidate === undefined) {
			throw unavailable(connectorId, "has no active device credential");
		}
		const parsed = connectorCredentialRefSchema.safeParse(candidate);
		if (!parsed.success) {
			throw new PlatformError(
				"MISSING_CONFIG",
				"env connector credential ref is invalid",
			);
		}
		const proxy = await buildProxy({
			organizationId,
			deviceId: null,
			connectorId,
			credentialRef: parsed.data,
		});
		return {
			deviceId: null,
			credentialId: null,
			credentialRef: parsed.data,
			scopes: [],
			metadata: {},
			proxy,
		};
	};

	return {
		async resolve(organizationId, connectorId) {
			const org = requireOrganizationId(organizationId);
			const connector = requireConnectorId(connectorId);

			const devices = await options.devices.listByOrganization(org);
			const activeDeviceIds = new Set(
				devices
					.filter(
						(device) =>
							device.organizationId === org && device.status === "active",
					)
					.map((device) => device.id),
			);
			if (activeDeviceIds.size === 0) {
				return resolveFallback(org, connector);
			}

			const credentials = await options.credentials.listByOrganization(org);
			const selected = selectActiveCredential(
				credentials,
				org,
				connector,
				activeDeviceIds,
			);
			if (selected === null) {
				return resolveFallback(org, connector);
			}

			const proxy = await buildProxy({
				organizationId: org,
				deviceId: selected.deviceId,
				connectorId: selected.connectorId,
				credentialRef: selected.credentialRef,
			});
			return {
				deviceId: selected.deviceId,
				credentialId: selected.id,
				credentialRef: selected.credentialRef,
				scopes: [...selected.scopes],
				metadata: { ...selected.metadata },
				proxy,
			};
		},
	};
}
