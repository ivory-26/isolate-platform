import { describe, expect, test } from "bun:test";
import type {
	ConnectorCallOutcome,
	ConnectorCallRecord,
	EnqueueConnectorCallInput,
	IncidentSignalSummary,
} from "@isolate/db";
import type {
	ConnectorIncidentRef,
	ResolvedConnectorDevice,
} from "@isolate/integrations";
import type { ContextBundle, OrganizationId, TaskId } from "@isolate/shared";
import {
	CONNECTOR_CONTEXT_TOOLS,
	type ConnectorContextDependencies,
	createConnectorContextLoader,
	createRoutedContextLoader,
} from "./connector-context";

const ORG = "11111111-1111-4111-8111-111111111111" as OrganizationId;
const OTHER_ORG = "22222222-2222-4222-8222-222222222222" as OrganizationId;
const TASK = "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f" as TaskId;
const DEVICE = "device-1";
const CREDENTIAL = "credential-1";

const SIGNAL: IncidentSignalSummary = {
	kind: "workflow_run.failed",
	severity: "high",
	service: "checkout",
	receivedAt: new Date("2026-11-01T00:00:00.000Z"),
};

const FINGERPRINTS: ReadonlyArray<
	readonly [ConnectorIncidentRef["source"], string]
> = [
	["sentry", "sentry:acme:web:42"],
	["grafana", "grafana:rule-1"],
	["pagerduty", "pagerduty:PSVC1:INC1"],
	["kubernetes", "k8s:prod:default:Deployment/web:CrashLoopBackOff"],
	["datadog", "datadog:12345"],
	["newrelic", "newrelic:abc123"],
	["honeycomb", "honeycomb:dataset1:trigger1:firing"],
	["axiom", "axiom:9876"],
	["signoz", "signoz:rule1"],
];

function bundleFor(fingerprint: string): ContextBundle {
	return {
		incidentFingerprint: fingerprint,
		items: [
			{
				source: "sentry",
				kind: "issue",
				title: "Checkout error rate",
				url: "https://sentry.example.com/issues/42",
				excerpt: "error rate spiked to 12%",
				fetchedAt: "2026-11-01T00:00:00.000Z",
				trustLevel: "untrusted",
				sha256: "a".repeat(64),
			},
		],
		truncated: false,
	};
}

function device(
	overrides: Partial<ResolvedConnectorDevice> = {},
): ResolvedConnectorDevice {
	return {
		deviceId: DEVICE,
		credentialId: CREDENTIAL,
		credentialRef: "keychain:isolate/sentry/prod",
		scopes: ["event:read"],
		metadata: {},
		proxy: {
			async execute() {
				return {
					ok: false as const,
					error: { code: "INTERNAL" as const, message: "unused" },
				};
			},
		},
		...overrides,
	};
}

type Harness = {
	loader: ReturnType<typeof createConnectorContextLoader>;
	enqueued: EnqueueConnectorCallInput[];
	resolveCalls: Array<{ organizationId: string; connectorId: string }>;
	signalCalls: Array<{ organizationId: string; source: string }>;
	setOutcome: (next: ConnectorCallOutcome | null) => void;
	setAwaitError: (error: unknown) => void;
	setEnqueueError: (error: unknown) => void;
};

function makeHarness(
	options: {
		resolve?: () => Promise<ResolvedConnectorDevice>;
		signal?: IncidentSignalSummary | null;
		overrides?: Partial<ConnectorContextDependencies>;
	} = {},
): Harness {
	const enqueued: EnqueueConnectorCallInput[] = [];
	const resolveCalls: Harness["resolveCalls"] = [];
	const signalCalls: Harness["signalCalls"] = [];
	let outcome: ConnectorCallOutcome | null = null;
	let awaitError: unknown = null;
	let enqueueError: unknown = null;

	const deps: ConnectorContextDependencies = {
		broker: {
			async resolve(organizationId, connectorId) {
				resolveCalls.push({ organizationId, connectorId });
				return options.resolve === undefined ? device() : options.resolve();
			},
		},
		calls: {
			async enqueue(input) {
				if (enqueueError !== null) throw enqueueError;
				enqueued.push(input);
				return { id: "call-1" } as unknown as ConnectorCallRecord;
			},
			async awaitResult() {
				if (awaitError !== null) throw awaitError;
				return outcome;
			},
		},
		signals: {
			async getLatestSignal(input) {
				signalCalls.push({
					organizationId: input.organizationId,
					source: input.source,
				});
				return options.signal === undefined ? SIGNAL : options.signal;
			},
		},
		...options.overrides,
	};

	return {
		loader: createConnectorContextLoader(deps),
		enqueued,
		resolveCalls,
		signalCalls,
		setOutcome(next) {
			outcome = next;
		},
		setAwaitError(error) {
			awaitError = error;
		},
		setEnqueueError(error) {
			enqueueError = error;
		},
	};
}

function input(fingerprint: string) {
	return {
		organizationId: ORG,
		taskId: TASK,
		incidentFingerprint: fingerprint,
	};
}

describe("connector context loader — source mapping", () => {
	test("each connector source maps to its device context tool", async () => {
		for (const [source, fingerprint] of FINGERPRINTS) {
			const harness = makeHarness();
			harness.setOutcome({ ok: true, data: bundleFor(fingerprint) });

			const result = await harness.loader(input(fingerprint));

			if (result === null) throw new Error(`no bundle for ${source}`);
			expect(result.incidentFingerprint).toBe(fingerprint);
			expect(harness.resolveCalls).toEqual([
				{
					organizationId: ORG,
					connectorId: CONNECTOR_CONTEXT_TOOLS[source].connectorId,
				},
			]);
			expect(harness.enqueued).toHaveLength(1);
			expect(harness.enqueued[0]?.connectorId).toBe(
				CONNECTOR_CONTEXT_TOOLS[source].connectorId,
			);
			// Kubernetes uses the adapter's short `k8s` prefix; the rest match the
			// source token.
			const prefix = source === "kubernetes" ? "k8s" : source;
			expect(harness.enqueued[0]?.toolName).toBe(`${prefix}.context.fetch`);
		}
	});

	test("sentry, datadog, axiom and the rest use the exact registered connector id", () => {
		expect(CONNECTOR_CONTEXT_TOOLS.kubernetes).toEqual({
			connectorId: "kubernetes",
			toolName: "k8s.context.fetch",
		});
		expect(CONNECTOR_CONTEXT_TOOLS.newrelic.connectorId).toBe("newrelic");
		expect(CONNECTOR_CONTEXT_TOOLS.signoz.toolName).toBe(
			"signoz.context.fetch",
		);
	});
});

describe("connector context loader — enqueue shape", () => {
	test("enqueues one bounded call carrying fingerprint, service and kind only", async () => {
		const fingerprint = "sentry:acme:web:42";
		const harness = makeHarness();
		harness.setOutcome({ ok: true, data: bundleFor(fingerprint) });

		await harness.loader(input(fingerprint));

		expect(harness.enqueued).toHaveLength(1);
		const call = harness.enqueued[0];
		if (call === undefined) throw new Error("no call enqueued");
		expect(call.organizationId).toBe(ORG);
		expect(call.deviceId).toBe(DEVICE);
		expect(call.credentialId).toBe(CREDENTIAL);
		expect(call.taskId).toBe(TASK);
		expect(call.ttlMs).toBe(60_000);
		expect(call.params).toEqual({
			incidentFingerprint: fingerprint,
			service: SIGNAL.service,
			kind: SIGNAL.kind,
		});
		expect(call.traceparent).toBeUndefined();
		// The device-side key name and any token never travel with the call.
		const serialized = JSON.stringify(call);
		expect(serialized).not.toContain("keychain:");
		expect(serialized).not.toContain("credentialRef");
		expect(serialized).not.toContain("credential_ref");
	});

	test("carries the traceparent when one is available", async () => {
		const fingerprint = "datadog:12345";
		const traceparent = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
		const harness = makeHarness();
		harness.setOutcome({ ok: true, data: bundleFor(fingerprint) });

		await harness.loader({ ...input(fingerprint), traceparent });

		expect(harness.enqueued[0]?.traceparent).toBe(traceparent);
	});

	test("a custom ttl and await timeout stay bounded below the ttl", async () => {
		const fingerprint = "axiom:9876";
		const harness = makeHarness({
			overrides: { ttlMs: 5_000, awaitTimeoutMs: 60_000, pollMs: 10 },
		});
		harness.setOutcome({ ok: true, data: bundleFor(fingerprint) });

		await harness.loader(input(fingerprint));

		expect(harness.enqueued[0]?.ttlMs).toBe(5_000);
	});
});

describe("connector context loader — delegation and degradation", () => {
	test("GitHub fingerprints are delegated: no broker, signal or enqueue", async () => {
		const harness = makeHarness();
		const result = await harness.loader(input("github:acme/widget:ci:main"));
		expect(result).toBeNull();
		expect(harness.resolveCalls).toHaveLength(0);
		expect(harness.signalCalls).toHaveLength(0);
		expect(harness.enqueued).toHaveLength(0);
	});

	test("a malformed or unknown fingerprint never enqueues", async () => {
		const harness = makeHarness();
		expect(await harness.loader(input("sentry:only-one-segment"))).toBeNull();
		expect(await harness.loader(input("unknown:source:1"))).toBeNull();
		expect(await harness.loader(input(""))).toBeNull();
		expect(harness.resolveCalls).toHaveLength(0);
		expect(harness.enqueued).toHaveLength(0);
	});

	test("no latest signal means no fabricated context and no call", async () => {
		const harness = makeHarness({ signal: null });
		const result = await harness.loader(input("grafana:rule-1"));
		expect(result).toBeNull();
		expect(harness.enqueued).toHaveLength(0);
	});

	test("a broker failure degrades to null without enqueueing", async () => {
		const harness = makeHarness({
			resolve: async () => {
				throw new Error("no active device");
			},
		});
		expect(await harness.loader(input("pagerduty:PSVC1:INC1"))).toBeNull();
		expect(harness.enqueued).toHaveLength(0);
	});

	test("a broker without a device queue (env fallback) degrades to null", async () => {
		const harness = makeHarness({
			resolve: async () => device({ deviceId: null, credentialId: null }),
		});
		expect(await harness.loader(input("sentry:acme:web:42"))).toBeNull();
		expect(harness.enqueued).toHaveLength(0);
	});

	test("an enqueue failure degrades to null", async () => {
		const harness = makeHarness();
		harness.setEnqueueError(new Error("db down"));
		expect(await harness.loader(input("sentry:acme:web:42"))).toBeNull();
	});
});

describe("connector context loader — result parsing", () => {
	test("a completed result is parsed into the shared bundle", async () => {
		const fingerprint = "honeycomb:dataset1:trigger1:firing";
		const bundle = bundleFor(fingerprint);
		const harness = makeHarness();
		harness.setOutcome({ ok: true, data: bundle });
		expect(await harness.loader(input(fingerprint))).toEqual(bundle);
	});

	test("an offline device (no result inside the timeout) yields null", async () => {
		const harness = makeHarness();
		harness.setOutcome(null);
		expect(await harness.loader(input("sentry:acme:web:42"))).toBeNull();
	});

	test("a device-reported failure yields null", async () => {
		const harness = makeHarness();
		harness.setOutcome({
			ok: false,
			errorCode: "INTEGRATION_UNAVAILABLE",
		});
		expect(await harness.loader(input("sentry:acme:web:42"))).toBeNull();
	});

	test("a malformed result yields null", async () => {
		const fingerprint = "sentry:acme:web:42";
		const harness = makeHarness();
		harness.setOutcome({
			ok: true,
			data: { incidentFingerprint: fingerprint, items: "not-an-array" },
		});
		expect(await harness.loader(input(fingerprint))).toBeNull();
	});

	test("a bundle for a different fingerprint is refused", async () => {
		const harness = makeHarness();
		harness.setOutcome({
			ok: true,
			data: bundleFor("sentry:other:project:99"),
		});
		expect(await harness.loader(input("sentry:acme:web:42"))).toBeNull();
	});

	test("an await failure yields null", async () => {
		const harness = makeHarness();
		harness.setAwaitError(new Error("db down"));
		expect(await harness.loader(input("sentry:acme:web:42"))).toBeNull();
	});
});

describe("routed context loader", () => {
	const REQUEST = {
		organizationId: ORG,
		taskId: TASK,
		repositoryFullName: "acme/widget",
		ref: "main",
	};

	function reader(fingerprint: string | null, organizationId = ORG) {
		return {
			async get() {
				return {
					organization_id: organizationId,
					incident_fingerprint: fingerprint,
				};
			},
		};
	}

	test("github fingerprints use the server-side reader", async () => {
		const seen: string[] = [];
		const loader = createRoutedContextLoader({
			tasks: reader("github:acme/widget:ci:main"),
			github: async () => {
				seen.push("github");
				return null;
			},
			connector: async () => {
				seen.push("connector");
				return null;
			},
		});
		await loader(REQUEST);
		expect(seen).toEqual(["github"]);
	});

	test("connector fingerprints are delegated to the device loader", async () => {
		const fingerprints: string[] = [];
		const loader = createRoutedContextLoader({
			tasks: reader("sentry:acme:web:42"),
			github: async () => {
				throw new Error("github must not be called");
			},
			connector: async (call) => {
				fingerprints.push(call.incidentFingerprint);
				return null;
			},
		});
		await loader(REQUEST);
		expect(fingerprints).toEqual(["sentry:acme:web:42"]);
	});

	test("without a device loader a non-GitHub fingerprint keeps the GitHub path", async () => {
		let calls = 0;
		const loader = createRoutedContextLoader({
			tasks: reader("sentry:acme:web:42"),
			github: async () => {
				calls += 1;
				return null;
			},
		});
		await loader(REQUEST);
		expect(calls).toBe(1);
	});

	test("ordinary, foreign and missing tasks never reach a reader", async () => {
		const seen: string[] = [];
		const delegates = {
			github: async () => {
				seen.push("github");
				return null;
			},
			connector: async () => {
				seen.push("connector");
				return null;
			},
		};
		expect(
			await createRoutedContextLoader({
				tasks: reader(null),
				...delegates,
			})(REQUEST),
		).toBeNull();
		expect(
			await createRoutedContextLoader({
				tasks: reader("sentry:acme:web:42", OTHER_ORG),
				...delegates,
			})(REQUEST),
		).toBeNull();
		expect(
			await createRoutedContextLoader({
				tasks: { get: async () => null },
				...delegates,
			})(REQUEST),
		).toBeNull();
		expect(
			await createRoutedContextLoader({
				tasks: reader("github:acme/widget:ci:main"),
			})(REQUEST),
		).toBeNull();
		expect(seen).toEqual([]);
	});
});
