import { describe, expect, test } from "bun:test";
import {
	asOrganizationId,
	type ConnectorCredentialSummary,
	type ConnectorDeviceSummary,
	type ErrorCode,
	PlatformError,
} from "@isolate/shared";
import {
	type ConnectorCredentialReader,
	type ConnectorDeviceBrokerOptions,
	type ConnectorDeviceReader,
	createConnectorDeviceBroker,
} from "./device-broker";
import {
	type DeviceProxy,
	type DeviceProxyFactory,
	type DeviceProxyTarget,
	NullDeviceProxy,
} from "./device-proxy";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const ENV_REF = "keychain:bridge/sentry";

function device(
	overrides: Partial<ConnectorDeviceSummary> = {},
): ConnectorDeviceSummary {
	return {
		id: DEVICE_ID,
		organizationId: ORG_A,
		userId: null,
		displayName: "Sahil's laptop",
		status: "active",
		lastSeenAt: new Date("2026-10-31T12:00:00.000Z"),
		createdAt: new Date("2026-10-31T11:00:00.000Z"),
		updatedAt: new Date("2026-10-31T12:00:00.000Z"),
		...overrides,
	};
}

function credential(
	overrides: Partial<ConnectorCredentialSummary> = {},
): ConnectorCredentialSummary {
	return {
		id: "44444444-4444-4444-8444-444444444444",
		organizationId: ORG_A,
		deviceId: DEVICE_ID,
		connectorId: "sentry",
		displayName: "Team Sentry",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/team",
		scopes: ["issues:read"],
		status: "active",
		freeTierProfile: {
			requestsPerMinute: null,
			requestsPerDay: null,
			eventsPerMonth: 5000,
			retentionDays: 30,
		},
		metadata: { enabledTools: ["sentry.issue_context"] },
		lastValidatedAt: new Date("2026-10-31T12:00:00.000Z"),
		lastUsedAt: null,
		...overrides,
	};
}

class TestDevices implements ConnectorDeviceReader {
	readonly rows: ConnectorDeviceSummary[] = [];
	calls = 0;

	async listByOrganization(
		organizationId: string,
	): Promise<ConnectorDeviceSummary[]> {
		this.calls += 1;
		return this.rows.filter((row) => row.organizationId === organizationId);
	}
}

class TestCredentials implements ConnectorCredentialReader {
	readonly rows: ConnectorCredentialSummary[] = [];
	calls = 0;

	async listByOrganization(
		organizationId: string,
	): Promise<ConnectorCredentialSummary[]> {
		this.calls += 1;
		return this.rows.filter((row) => row.organizationId === organizationId);
	}
}

function fixture(options: {
	devices?: ConnectorDeviceSummary[];
	credentials?: ConnectorCredentialSummary[];
	factory?: DeviceProxyFactory;
	allowEnvFallback?: boolean;
	lookup?: ConnectorDeviceBrokerOptions["credentialRefLookup"];
}) {
	const devices = new TestDevices();
	devices.rows.push(...(options.devices ?? [device()]));
	const credentials = new TestCredentials();
	credentials.rows.push(...(options.credentials ?? [credential()]));
	const targets: DeviceProxyTarget[] = [];
	const proxy = { tag: "proxy" } as unknown as DeviceProxy;
	const factory: DeviceProxyFactory =
		options.factory ??
		((target) => {
			targets.push(target);
			return proxy;
		});
	const broker = createConnectorDeviceBroker({
		devices,
		credentials,
		proxyFactory: factory,
		allowEnvFallback: options.allowEnvFallback,
		credentialRefLookup: options.lookup,
	});
	return { broker, devices, credentials, targets, proxy };
}

async function expectCode(
	promise: Promise<unknown>,
	code: ErrorCode,
): Promise<PlatformError> {
	try {
		await promise;
		throw new Error("resolve unexpectedly succeeded");
	} catch (error) {
		expect(error).toBeInstanceOf(PlatformError);
		const platformError = error as PlatformError;
		expect(platformError.code).toBe(code);
		return platformError;
	}
}

describe("connector device broker", () => {
	test("resolves an active device and credential into metadata plus a proxy", async () => {
		const { broker, targets, proxy } = fixture({});
		const resolved = await broker.resolve(ORG_A, "sentry");
		expect(resolved.credentialRef).toBe("keychain:isolate/sentry/team");
		expect(resolved.scopes).toEqual(["issues:read"]);
		expect(resolved.metadata).toEqual({
			enabledTools: ["sentry.issue_context"],
		});
		expect(resolved.proxy).toBe(proxy);
		expect(Object.keys(resolved).sort()).toEqual([
			"credentialRef",
			"metadata",
			"proxy",
			"scopes",
		]);
		expect(targets).toEqual([
			{
				organizationId: ORG_A,
				deviceId: DEVICE_ID,
				connectorId: "sentry",
				credentialRef: "keychain:isolate/sentry/team",
			},
		]);
		const serialized = JSON.stringify(resolved, (_key, value) =>
			value === proxy ? "[proxy]" : value,
		);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("token");
	});

	test("inactive credentials are unavailable and never reach the factory", async () => {
		for (const status of [
			"pending_validation",
			"invalid",
			"revoked",
		] as const) {
			const { broker, targets } = fixture({
				credentials: [credential({ status })],
			});
			const error = await expectCode(
				broker.resolve(ORG_A, "sentry"),
				"INTEGRATION_UNAVAILABLE",
			);
			expect(error.message).toContain('connector "sentry"');
			expect(targets).toHaveLength(0);
		}
	});

	test("a device that is not active makes its credentials unusable", async () => {
		for (const status of ["pending", "revoked"] as const) {
			const { broker, credentials, targets } = fixture({
				devices: [device({ status })],
			});
			await expectCode(
				broker.resolve(ORG_A, "sentry"),
				"INTEGRATION_UNAVAILABLE",
			);
			expect(credentials.calls).toBe(0);
			expect(targets).toHaveLength(0);
		}
	});

	test("cross-tenant and unknown connectors are indistinguishable", async () => {
		const crossTenant = fixture({
			credentials: [credential({ organizationId: ORG_B })],
		});
		await expectCode(
			crossTenant.broker.resolve(ORG_A, "sentry"),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(crossTenant.targets).toHaveLength(0);

		const otherConnector = fixture({});
		await expectCode(
			otherConnector.broker.resolve(ORG_A, "pagerduty"),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(otherConnector.targets).toHaveLength(0);
	});

	test("picks deterministically when two rows are active", async () => {
		const { broker, targets } = fixture({
			credentials: [
				credential({
					id: "55555555-5555-4555-8555-555555555555",
					displayName: "Zeta",
					credentialRef: "keychain:z",
				}),
				credential({
					id: "66666666-6666-4666-8666-666666666666",
					displayName: "Alpha",
					credentialRef: "keychain:a",
				}),
			],
		});
		const resolved = await broker.resolve(ORG_A, "sentry");
		expect(resolved.credentialRef).toBe("keychain:a");
		expect(targets[0].credentialRef).toBe("keychain:a");
	});

	test("the environment fallback is off by default and names only a ref", async () => {
		let lookups = 0;
		const lookup = () => {
			lookups += 1;
			return ENV_REF;
		};
		const disabled = fixture({
			devices: [],
			credentials: [],
			lookup,
		});
		await expectCode(
			disabled.broker.resolve(ORG_A, "sentry"),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(lookups).toBe(0);

		const enabled = fixture({
			devices: [],
			credentials: [],
			allowEnvFallback: true,
			lookup,
		});
		const resolved = await enabled.broker.resolve(ORG_A, "sentry");
		expect(resolved).toEqual({
			credentialRef: ENV_REF,
			scopes: [],
			metadata: {},
			proxy: enabled.proxy,
		});
		expect(lookups).toBe(1);
		expect(enabled.targets[0].deviceId).toBeNull();
	});

	test("an active row wins over the environment fallback", async () => {
		let lookups = 0;
		const { broker } = fixture({
			allowEnvFallback: true,
			lookup: () => {
				lookups += 1;
				return ENV_REF;
			},
		});
		const resolved = await broker.resolve(ORG_A, "sentry");
		expect(resolved.credentialRef).toBe("keychain:isolate/sentry/team");
		expect(lookups).toBe(0);
	});

	test("a malformed or throwing env ref fails closed without echoing it", async () => {
		const blank = fixture({
			devices: [],
			credentials: [],
			allowEnvFallback: true,
			lookup: () => "   ",
		});
		const error = await expectCode(
			blank.broker.resolve(ORG_A, "sentry"),
			"MISSING_CONFIG",
		);
		expect(error.message).toBe("env connector credential ref is invalid");

		const throwing = fixture({
			devices: [],
			credentials: [],
			allowEnvFallback: true,
			lookup: () => {
				throw new PlatformError("INTERNAL", "boom SECRET-VALUE");
			},
		});
		const thrown = await expectCode(
			throwing.broker.resolve(ORG_A, "sentry"),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(thrown.message).not.toContain("SECRET-VALUE");
	});

	test("a missing or failing proxy factory fails closed", async () => {
		const nullFactory = fixture({ factory: () => null });
		await expectCode(
			nullFactory.broker.resolve(ORG_A, "sentry"),
			"INTEGRATION_UNAVAILABLE",
		);

		const throwingFactory = fixture({
			factory: () => {
				throw new Error("transport config has SECRET-VALUE");
			},
		});
		const error = await expectCode(
			throwingFactory.broker.resolve(ORG_A, "sentry"),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(error.message).not.toContain("SECRET-VALUE");
	});

	test("the null factory yields a fail-closed proxy", async () => {
		const factories = new Map<string, DeviceProxy>();
		const devices = new TestDevices();
		devices.rows.push(device());
		const credentials = new TestCredentials();
		credentials.rows.push(credential());
		const broker = createConnectorDeviceBroker({
			devices,
			credentials,
			proxyFactory: () => {
				const proxy = new NullDeviceProxy();
				factories.set("proxy", proxy);
				return proxy;
			},
		});
		const resolved = await broker.resolve(ORG_A, "sentry");
		const result = await resolved.proxy.execute({
			connectorId: "sentry",
			credentialRef: resolved.credentialRef,
			operation: "issues.list",
		});
		expect(result.ok).toBe(false);
	});

	test("invalid ids and incomplete options fail fast", async () => {
		const { broker } = fixture({});
		await expectCode(broker.resolve(ORG_A, "Sentry"), "VALIDATION_FAILED");
		await expectCode(
			broker.resolve("" as never, "sentry"),
			"VALIDATION_FAILED",
		);
		expect(() =>
			createConnectorDeviceBroker({
				devices: new TestDevices(),
				credentials: new TestCredentials(),
				proxyFactory: undefined as never,
			}),
		).toThrow(PlatformError);
		expect(() =>
			createConnectorDeviceBroker({
				devices: new TestDevices(),
				credentials: new TestCredentials(),
				proxyFactory: () => new NullDeviceProxy(),
				allowEnvFallback: true,
			}),
		).toThrow(PlatformError);
	});
});
