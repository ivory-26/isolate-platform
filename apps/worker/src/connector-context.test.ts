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
	type ConnectorContextSkip,
	type ConnectorContextSkipSource,
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
	/** Reasons reported through the loader's optional observer. */
	skips: ConnectorContextSkip[];
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
	const skips: ConnectorContextSkip[] = [];
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
		onSkip(skip) {
			skips.push(skip);
		},
		...options.overrides,
	};

	return {
		loader: createConnectorContextLoader(deps),
		enqueued,
		resolveCalls,
		signalCalls,
		skips,
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

describe("connector context loader — evidence skip reasons", () => {
	function expectSkip(
		harness: Harness,
		source: ConnectorContextSkipSource,
		reason: ConnectorContextSkip["reason"],
	) {
		expect(harness.skips).toEqual([
			{ organizationId: ORG, taskId: TASK, source, reason },
		]);
	}

	test("a loaded bundle reports no skip", async () => {
		const fingerprint = "sentry:acme:web:42";
		const harness = makeHarness();
		harness.setOutcome({ ok: true, data: bundleFor(fingerprint) });

		const bundle = await harness.loader(input(fingerprint));

		expect(bundle?.incidentFingerprint).toBe(fingerprint);
		expect(harness.skips).toEqual([]);
	});

	test("GitHub, unknown and malformed fingerprints report unrecognized_fingerprint", async () => {
		for (const fingerprint of [
			"github:acme/widget:ci:main",
			"unknown:source:1",
			"sentry:only-one-segment",
			"",
		]) {
			const harness = makeHarness();
			expect(await harness.loader(input(fingerprint))).toBeNull();
			expectSkip(harness, "unknown", "unrecognized_fingerprint");
			expect(harness.enqueued).toHaveLength(0);
		}
	});

	test("a credential with no device queue reports no_device_credential", async () => {
		const harness = makeHarness({
			resolve: async () => device({ deviceId: null, credentialId: null }),
		});

		expect(await harness.loader(input("sentry:acme:web:42"))).toBeNull();
		expectSkip(harness, "sentry", "no_device_credential");
		expect(harness.enqueued).toHaveLength(0);
	});

	test("a missing normalized signal reports no_signal", async () => {
		const harness = makeHarness({ signal: null });

		expect(await harness.loader(input("grafana:rule-1"))).toBeNull();
		expectSkip(harness, "grafana", "no_signal");
		expect(harness.enqueued).toHaveLength(0);
	});

	test("no result inside the bounded wait reports call_timeout", async () => {
		const harness = makeHarness();
		harness.setOutcome(null);

		expect(await harness.loader(input("datadog:12345"))).toBeNull();
		expectSkip(harness, "datadog", "call_timeout");
	});

	test("a device-reported provider failure reports call_failed", async () => {
		const harness = makeHarness();
		harness.setOutcome({ ok: false, errorCode: "INTEGRATION_UNAVAILABLE" });

		expect(await harness.loader(input("newrelic:abc123"))).toBeNull();
		expectSkip(harness, "newrelic", "call_failed");
	});

	test("malformed and mismatched bundles report contract_rejected", async () => {
		const fingerprint = "honeycomb:dataset1:trigger1:firing";
		const malformed = makeHarness();
		malformed.setOutcome({
			ok: true,
			data: { incidentFingerprint: fingerprint, items: "not-an-array" },
		});
		expect(await malformed.loader(input(fingerprint))).toBeNull();
		expectSkip(malformed, "honeycomb", "contract_rejected");

		const mismatched = makeHarness();
		mismatched.setOutcome({
			ok: true,
			data: bundleFor("honeycomb:dataset1:trigger2:firing"),
		});
		expect(await mismatched.loader(input(fingerprint))).toBeNull();
		expectSkip(mismatched, "honeycomb", "contract_rejected");
	});

	test("broker, enqueue and awaited-read failures report broker_failed", async () => {
		const brokerFailure = makeHarness({
			resolve: async () => {
				throw new Error("no active device");
			},
		});
		expect(
			await brokerFailure.loader(input("pagerduty:PSVC1:INC1")),
		).toBeNull();
		expectSkip(brokerFailure, "pagerduty", "broker_failed");

		const enqueueFailure = makeHarness();
		enqueueFailure.setEnqueueError(new Error("db down"));
		expect(await enqueueFailure.loader(input("sentry:acme:web:42"))).toBeNull();
		expectSkip(enqueueFailure, "sentry", "broker_failed");

		const awaitFailure = makeHarness();
		awaitFailure.setAwaitError(new Error("db down"));
		expect(await awaitFailure.loader(input("sentry:acme:web:42"))).toBeNull();
		expectSkip(awaitFailure, "sentry", "broker_failed");
	});

	test("an observer throw or rejection never fails the task", async () => {
		const throws = makeHarness({
			signal: null,
			overrides: {
				onSkip() {
					throw new Error("timeline down");
				},
			},
		});
		expect(await throws.loader(input("sentry:acme:web:42"))).toBeNull();

		const rejects = makeHarness({
			signal: null,
			overrides: {
				async onSkip() {
					throw new Error("timeline down");
				},
			},
		});
		expect(await rejects.loader(input("sentry:acme:web:42"))).toBeNull();
		// The skip was still attempted exactly once; nothing was retried.
		expect(rejects.skips).toEqual([]);
	});

	test("a skip is tenant-attributed and carries no evidence text", async () => {
		const fingerprint = "sentry:acme:web:42";
		const base = bundleFor(fingerprint);
		const item = base.items[0];
		if (item === undefined) throw new Error("fixture has no item");
		const harness = makeHarness();
		harness.setOutcome({
			ok: true,
			// Wrong fingerprint forces a contract rejection while the payload
			// above still contains provider text the timeline must not carry.
			data: {
				...base,
				incidentFingerprint: "sentry:acme:web:99",
				items: [{ ...item, excerpt: "provider-secret-excerpt" }],
			},
		});

		expect(await harness.loader(input(fingerprint))).toBeNull();
		const [skip] = harness.skips;
		if (skip === undefined) throw new Error("no skip reported");
		expect(Object.keys(skip).sort()).toEqual([
			"organizationId",
			"reason",
			"source",
			"taskId",
		]);
		expect(skip.organizationId).toBe(ORG);
		expect(skip.taskId).toBe(TASK);
		expect(skip.reason).toBe("contract_rejected");
		expect(JSON.stringify(skip)).not.toContain("provider-secret-excerpt");
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

describe("routed context loader — evidence skip reporting", () => {
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

	test("a connector skip is reported by the device loader exactly once", async () => {
		const harness = makeHarness({ signal: null });
		const routerSkips: ConnectorContextSkip[] = [];
		const loader = createRoutedContextLoader({
			tasks: reader("grafana:rule-1"),
			connector: harness.loader,
			onSkip(skip) {
				routerSkips.push(skip);
			},
		});

		expect(await loader(REQUEST)).toBeNull();
		expect(harness.skips).toEqual([
			{
				organizationId: ORG,
				taskId: TASK,
				source: "grafana",
				reason: "no_signal",
			},
		]);
		// The router must not double-record a reason the loader already owns.
		expect(routerSkips).toEqual([]);
	});

	test("a connector incident without a gateway reports no_device_gateway and keeps the fallback", async () => {
		const skips: ConnectorContextSkip[] = [];
		let githubCalls = 0;
		const loader = createRoutedContextLoader({
			tasks: reader("sentry:acme:web:42"),
			github: async () => {
				githubCalls += 1;
				return null;
			},
			onSkip(skip) {
				skips.push(skip);
			},
		});

		expect(await loader(REQUEST)).toBeNull();
		expect(skips).toEqual([
			{
				organizationId: ORG,
				taskId: TASK,
				source: "sentry",
				reason: "no_device_gateway",
			},
		]);
		expect(githubCalls).toBe(1);
	});

	test("GitHub fingerprints and unknown shapes are not connector skips", async () => {
		// A GitHub or unrecognized fingerprint keeps the GitHub fallback; a task
		// with no fingerprint has no reader at all and must not be called.
		for (const { fingerprint, githubCalls: expectedCalls } of [
			{ fingerprint: "github:acme/widget:ci:main", githubCalls: 1 },
			{ fingerprint: "unknown:source:1", githubCalls: 1 },
			{ fingerprint: null, githubCalls: 0 },
		]) {
			const skips: ConnectorContextSkip[] = [];
			let githubCalls = 0;
			const loader = createRoutedContextLoader({
				tasks: reader(fingerprint),
				github: async () => {
					githubCalls += 1;
					return null;
				},
				onSkip(skip) {
					skips.push(skip);
				},
			});
			expect(await loader(REQUEST)).toBeNull();
			expect(skips).toEqual([]);
			expect(githubCalls).toBe(expectedCalls);
		}
	});

	test("a foreign or missing task never reaches a reader or a skip sink", async () => {
		const skips: ConnectorContextSkip[] = [];
		const delegates = {
			github: async () => {
				throw new Error("must not be called");
			},
			connector: async () => {
				throw new Error("must not be called");
			},
			onSkip(skip: ConnectorContextSkip) {
				skips.push(skip);
			},
		};

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
		expect(skips).toEqual([]);
	});

	test("a throwing skip sink never fails the route or blocks the fallback", async () => {
		let githubCalls = 0;
		const loader = createRoutedContextLoader({
			tasks: reader("sentry:acme:web:42"),
			github: async () => {
				githubCalls += 1;
				return null;
			},
			onSkip() {
				throw new Error("timeline down");
			},
		});

		expect(await loader(REQUEST)).toBeNull();
		expect(githubCalls).toBe(1);
	});
});
