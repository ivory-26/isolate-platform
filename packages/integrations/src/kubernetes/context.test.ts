import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import {
	fetchKubernetesContext,
	KUBERNETES_CONTEXT_MAX_EVENTS,
	KUBERNETES_CONTEXT_MAX_REPLICASETS,
	type KubernetesContextDependencies,
} from "./context";
import type {
	KubernetesHttpClient,
	KubernetesJsonResult,
	KubernetesQuery,
	KubernetesTextResult,
} from "./types";

const NAMESPACE = "payments";
const POD = "api-7c9f-abc";
const DEPLOYMENT = "api";
const NOW = Date.parse("2026-10-31T00:00:00.000Z");
const TOKEN =
	"<jwt-redacted>";

type Call = {
	method: "get" | "getText";
	path: string;
	query: KubernetesQuery | undefined;
};

function json(status: number, body: unknown): KubernetesJsonResult {
	return { status, body };
}

function text(status: number, value: string): KubernetesTextResult {
	return { status, text: value };
}

function event(index: number) {
	return {
		metadata: {
			name: `api.${index}`,
			namespace: NAMESPACE,
			uid: `event-${index}`,
			creationTimestamp: "2026-10-30T23:00:00Z",
		},
		involvedObject: {
			kind: "Pod",
			name: POD,
			namespace: NAMESPACE,
			uid: "pod-uid",
		},
		reason: "CrashLoopBackOff",
		message: `Back-off restarting failed container (attempt ${index})`,
		type: "Warning",
		count: index,
		firstTimestamp: "2026-10-30T23:00:00Z",
		lastTimestamp: `2026-10-30T23:${String(index).padStart(2, "0")}:00Z`,
	};
}

function eventList(count: number) {
	return {
		metadata: { resourceVersion: "100" },
		items: Array.from({ length: count }, (_, index) => event(index + 1)),
	};
}

const POD_BODY = {
	metadata: {
		name: POD,
		namespace: NAMESPACE,
		uid: "pod-uid",
		labels: { app: "api" },
	},
	spec: {
		nodeName: "node-internal-1",
		containers: [
			{
				name: "api",
				image: "registry.example.com/api:v1",
				env: [{ name: "DATABASE_PASSWORD", value: "hunter2" }],
				resources: { limits: { memory: "128Mi", cpu: "250m" } },
			},
		],
	},
	status: {
		phase: "Running",
		podIP: "10.0.0.17",
		conditions: [
			{
				type: "Ready",
				status: "False",
				reason: "ContainersNotReady",
				message: "containers with unready status: [api]",
				lastTransitionTime: "2026-10-30T23:00:00Z",
			},
		],
		containerStatuses: [
			{
				name: "api",
				ready: false,
				restartCount: 9,
				state: {
					waiting: {
						reason: "CrashLoopBackOff",
						message: "back-off 5m0s restarting failed container",
					},
				},
				lastState: {
					terminated: { reason: "OOMKilled", exitCode: 137 },
				},
			},
		],
	},
};

const DEPLOYMENT_BODY = {
	metadata: { name: DEPLOYMENT, namespace: NAMESPACE, generation: 5 },
	spec: { replicas: 3, selector: { matchLabels: { app: "api" } } },
	status: {
		observedGeneration: 4,
		replicas: 4,
		readyReplicas: 1,
		availableReplicas: 1,
		unavailableReplicas: 2,
		updatedReplicas: 3,
		conditions: [
			{
				type: "Available",
				status: "False",
				reason: "MinimumReplicasUnavailable",
				message: "Deployment does not have minimum availability.",
				lastTransitionTime: "2026-10-30T23:00:00Z",
			},
		],
	},
};

function replicaSet(index: number, owner = DEPLOYMENT) {
	return {
		metadata: {
			name: `api-${index}`,
			namespace: NAMESPACE,
			uid: `rs-${index}`,
			annotations: { "deployment.kubernetes.io/revision": String(index) },
			ownerReferences: [{ kind: "Deployment", name: owner, uid: "dep-uid" }],
		},
		spec: {
			replicas: index,
			template: {
				spec: { containers: [{ name: "api", image: `api:v${index}` }] },
			},
		},
		status: {
			replicas: index,
			readyReplicas: index - 1,
			availableReplicas: index - 1,
		},
	};
}

function logTail(lines: number): string {
	return Array.from({ length: lines }, (_, index) => {
		return `2026-10-30T23:00:00Z line ${index} password=hunter2 user ops@example.com token=${TOKEN}`;
	}).join("\n");
}

type Routes = {
	events?: KubernetesJsonResult;
	pod?: KubernetesJsonResult;
	log?: KubernetesTextResult;
	deployment?: KubernetesJsonResult;
	replicaSets?: KubernetesJsonResult;
	throwOn?: "events" | "pod" | "log" | "deployment" | "replicaSets";
};

function fakeClient(routes: Routes = {}): {
	client: KubernetesHttpClient;
	calls: Call[];
} {
	const calls: Call[] = [];
	const client: KubernetesHttpClient = {
		async get(path, query): Promise<KubernetesJsonResult> {
			calls.push({ method: "get", path, query });
			if (routes.throwOn === "events" && path.endsWith("/events")) {
				throw new Error(`transport failed for bearer ${TOKEN}`);
			}
			if (routes.throwOn === "pod" && path.includes("/pods/")) {
				throw new Error(`transport failed for bearer ${TOKEN}`);
			}
			if (path.endsWith("/events")) {
				return routes.events ?? json(200, eventList(0));
			}
			if (path.includes("/pods/")) {
				return routes.pod ?? json(200, POD_BODY);
			}
			if (path.includes("/deployments/")) {
				return routes.deployment ?? json(200, DEPLOYMENT_BODY);
			}
			if (path.endsWith("/replicasets")) {
				return (
					routes.replicaSets ??
					json(200, {
						items: Array.from({ length: 8 }, (_, index) =>
							replicaSet(index + 1),
						),
					})
				);
			}
			return json(404, {});
		},
		async getText(path, query): Promise<KubernetesTextResult> {
			calls.push({ method: "getText", path, query });
			if (routes.throwOn === "log") {
				throw new Error(`transport failed for bearer ${TOKEN}`);
			}
			if (routes.throwOn === "deployment" && path.includes("/deployments/")) {
				throw new Error(`transport failed for bearer ${TOKEN}`);
			}
			return routes.log ?? text(200, logTail(250));
		},
	};
	return { client, calls };
}

function dependencies(
	client: KubernetesHttpClient,
	overrides: Partial<KubernetesContextDependencies> = {},
): KubernetesContextDependencies {
	return {
		client,
		namespace: NAMESPACE,
		clusterId: "prod-eu",
		now: () => NOW,
		...overrides,
	};
}

const INPUT = {
	incidentFingerprint: "k8s:prod-eu:payments:pod/api-7c9f-abc:CrashLoopBackOff",
	namespace: NAMESPACE,
	kind: "Pod" as const,
	name: POD,
	podName: POD,
	deploymentName: DEPLOYMENT,
};

function itemByKind(
	items: readonly { kind: string }[],
	kind: string,
): { kind: string; excerpt: string; url?: string; sha256: string } | undefined {
	return items.find((item) => item.kind === kind) as
		| { kind: string; excerpt: string; url?: string; sha256: string }
		| undefined;
}

describe("fetchKubernetesContext", () => {
	test("assembles a bounded five-item bundle from five calls", async () => {
		const { client, calls } = fakeClient({
			events: json(200, eventList(12)),
		});
		const bundle = await fetchKubernetesContext(dependencies(client), INPUT);

		expect(bundle.incidentFingerprint).toBe(INPUT.incidentFingerprint);
		expect(bundle.items).toHaveLength(5);
		expect(bundle.truncated).toBe(true);
		expect(calls).toHaveLength(5);
		expect(calls.map((call) => call.method)).toEqual([
			"get",
			"get",
			"getText",
			"get",
			"get",
		]);
		const totalBytes = new TextEncoder().encode(
			bundle.items.map((item) => item.excerpt).join(""),
		).byteLength;
		expect(totalBytes).toBeLessThanOrEqual(MAX_CONTEXT_TOTAL_EXCERPT_BYTES);
		for (const item of bundle.items) {
			expect(item.source).toBe("kubernetes");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.fetchedAt).toBe("2026-10-31T00:00:00.000Z");
			expect(item.sha256).toBe(
				createHash("sha256").update(item.excerpt).digest("hex"),
			);
			expect(item.excerpt.length).toBeLessThanOrEqual(4000);
			expect(item.url?.startsWith("https://")).toBe(true);
			expect(JSON.stringify(item)).not.toContain(TOKEN);
		}

		const events = itemByKind(bundle.items, "kubernetes_events");
		const eventLines = events?.excerpt.split("\n") ?? [];
		expect(eventLines).toHaveLength(KUBERNETES_CONTEXT_MAX_EVENTS);
		expect(events?.excerpt).toContain("CrashLoopBackOff");

		const pod = itemByKind(bundle.items, "kubernetes_pod");
		expect(pod?.excerpt).toContain("restarts=9");
		expect(pod?.excerpt).toContain("waiting:CrashLoopBackOff");
		expect(pod?.excerpt).toContain(
			"lastTerminated=terminated:OOMKilled(exit 137)",
		);
		expect(pod?.excerpt).toContain(
			"Container api limits: cpu=250m, memory=128Mi",
		);
		expect(JSON.stringify(pod)).not.toContain("hunter2");
		expect(JSON.stringify(pod)).not.toContain("10.0.0.17");
		expect(JSON.stringify(pod)).not.toContain("node-internal-1");

		const logs = itemByKind(bundle.items, "kubernetes_logs");
		expect(logs?.excerpt.split("\n").length).toBeLessThanOrEqual(200);
		expect(logs?.excerpt.length).toBeLessThanOrEqual(2000);
		expect(logs?.excerpt).not.toContain("hunter2");
		expect(logs?.excerpt).not.toContain("ops@example.com");
		expect(logs?.excerpt).not.toContain(TOKEN);
		expect(logs?.excerpt).toContain("[redacted]");

		const deployment = itemByKind(bundle.items, "kubernetes_deployment");
		expect(deployment?.excerpt).toContain(
			"Replicas: desired=3 ready=1 available=1 unavailable=2 updated=3",
		);
		expect(deployment?.excerpt).toContain(
			"Observed generation: 4 (generation 5)",
		);
		expect(deployment?.excerpt).toContain("MinimumReplicasUnavailable");

		const replicaSets = itemByKind(bundle.items, "kubernetes_replicasets");
		expect(replicaSets?.excerpt.split("\n")).toHaveLength(
			KUBERNETES_CONTEXT_MAX_REPLICASETS,
		);
		expect(replicaSets?.excerpt).toContain("revision=5");
		expect(replicaSets?.excerpt).not.toContain("revision=8");
	});

	test("sends only the documented namespaced queries", async () => {
		const { client, calls } = fakeClient({ events: json(200, eventList(2)) });
		await fetchKubernetesContext(dependencies(client), INPUT);

		const events = calls[0];
		expect(events?.path).toBe("/api/v1/namespaces/payments/events");
		expect(events?.query).toEqual({
			fieldSelector: `involvedObject.name=${POD},type=Warning`,
			limit: "50",
		});
		expect(calls[1]?.path).toBe(`/api/v1/namespaces/payments/pods/${POD}`);
		expect(calls[2]?.path).toBe(`/api/v1/namespaces/payments/pods/${POD}/log`);
		expect(calls[2]?.query).toEqual({
			tailLines: "200",
			timestamps: "true",
			sinceSeconds: "3600",
		});
		expect(calls[2]?.query).not.toHaveProperty("follow");
		expect(calls[3]?.path).toBe(
			"/apis/apps/v1/namespaces/payments/deployments/api",
		);
		expect(calls[4]?.path).toBe(
			"/apis/apps/v1/namespaces/payments/replicasets",
		);
		expect(calls[4]?.query).toEqual({
			labelSelector: "app=api",
			limit: "20",
		});

		for (const call of calls) {
			expect(call.path).toContain("/namespaces/");
			expect(call.path).not.toContain("secrets");
			expect(call.path).not.toContain("configmaps");
			expect(call.path).not.toContain("exec");
			expect(call.path).not.toContain("follow");
		}
	});

	test("fails closed when the core events read is denied", async () => {
		const { client, calls } = fakeClient({ events: json(403, {}) });
		let error: unknown;
		try {
			await fetchKubernetesContext(dependencies(client), INPUT);
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(PlatformError);
		expect((error as PlatformError).code).toBe("POLICY_DENIED");
		expect(calls).toHaveLength(1);
	});

	test("drops optional resources on 403 without failing the bundle", async () => {
		const { client, calls } = fakeClient({
			events: json(200, eventList(3)),
			pod: json(403, {}),
			log: text(403, ""),
			deployment: json(403, {}),
			replicaSets: json(403, {}),
		});
		const bundle = await fetchKubernetesContext(dependencies(client), INPUT);
		expect(bundle.truncated).toBe(true);
		expect(itemByKind(bundle.items, "kubernetes_events")).toBeDefined();
		expect(itemByKind(bundle.items, "kubernetes_pod")).toBeUndefined();
		expect(itemByKind(bundle.items, "kubernetes_logs")).toBeUndefined();
		expect(itemByKind(bundle.items, "kubernetes_deployment")).toBeUndefined();
		expect(itemByKind(bundle.items, "kubernetes_replicasets")).toBeUndefined();
		expect(calls.length).toBeLessThanOrEqual(5);
	});

	test("treats a missing pod and log as absent evidence", async () => {
		const { client } = fakeClient({
			events: json(200, eventList(1)),
			pod: json(404, {}),
			log: text(404, ""),
			deployment: json(404, {}),
		});
		const bundle = await fetchKubernetesContext(dependencies(client), INPUT);
		expect(bundle.truncated).toBe(true);
		expect(itemByKind(bundle.items, "kubernetes_pod")).toBeUndefined();
		expect(itemByKind(bundle.items, "kubernetes_logs")).toBeUndefined();
		expect(itemByKind(bundle.items, "kubernetes_deployment")).toBeUndefined();
	});

	test("maps 429 to RATE_LIMITED and 401 to INTEGRATION_UNAVAILABLE", async () => {
		for (const [status, code] of [
			[429, "RATE_LIMITED"],
			[401, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const { client } = fakeClient({ events: json(status, {}) });
			let error: unknown;
			try {
				await fetchKubernetesContext(dependencies(client), INPUT);
			} catch (thrown) {
				error = thrown;
			}
			expect((error as PlatformError).code).toBe(code);
		}
	});

	test("maps provider drift to truncated evidence, not raw text", async () => {
		const { client } = fakeClient({
			events: json(200, { items: [{ garbage: true }] }),
		});
		const bundle = await fetchKubernetesContext(dependencies(client), INPUT);
		expect(bundle.truncated).toBe(true);
		expect(itemByKind(bundle.items, "kubernetes_events")).toBeUndefined();
		expect(JSON.stringify(bundle)).not.toContain("garbage");
	});

	test("rejects a foreign namespace with NOT_FOUND before any call", async () => {
		const { client, calls } = fakeClient();
		let error: unknown;
		try {
			await fetchKubernetesContext(dependencies(client), {
				...INPUT,
				namespace: "other",
			});
		} catch (thrown) {
			error = thrown;
		}
		expect((error as PlatformError).code).toBe("NOT_FOUND");
		expect(calls).toHaveLength(0);
	});

	test("never echoes a token or transport message", async () => {
		for (const throwOn of ["events", "pod", "log"] as const) {
			const { client } = fakeClient({ throwOn });
			let error: unknown;
			try {
				await fetchKubernetesContext(dependencies(client), INPUT);
			} catch (thrown) {
				error = thrown;
			}
			expect((error as PlatformError).code).toBe("INTEGRATION_UNAVAILABLE");
			expect(String((error as Error).message)).not.toContain(TOKEN);
			expect(String((error as Error).message)).not.toContain(
				"transport failed",
			);
		}
	});

	test("rejects malformed input before calling the API", async () => {
		const { client, calls } = fakeClient();
		for (const input of [
			{ ...INPUT, name: "Bad/Name" },
			{ ...INPUT, kind: "Secret" },
			{ ...INPUT, incidentFingerprint: "" },
		]) {
			let error: unknown;
			try {
				await fetchKubernetesContext(dependencies(client), input as never);
			} catch (thrown) {
				error = thrown;
			}
			expect((error as PlatformError).code).toBe("VALIDATION_FAILED");
		}
		expect(calls).toHaveLength(0);
	});
});
