import { describe, expect, test } from "bun:test";
import {
	KUBERNETES_MAX_ITEMS,
	kubernetesDeploymentSchema,
	kubernetesEventListSchema,
	kubernetesEventSchema,
	kubernetesPodSchema,
	kubernetesReplicaSetListSchema,
} from "./schemas";

const EVENT = {
	metadata: {
		name: "api.7c9f",
		namespace: "payments",
		uid: "event-uid",
		managedFields: [{ manager: "kubelet" }],
	},
	involvedObject: {
		kind: "Pod",
		name: "api-7c9f-abc",
		namespace: "payments",
		uid: "pod-uid",
		related: { kind: "Secret", name: "db-creds" },
	},
	reason: "CrashLoopBackOff",
	message: "Back-off restarting failed container",
	type: "Warning",
	count: 4,
	lastTimestamp: "2026-10-31T00:00:00Z",
};

describe("kubernetes wire schemas", () => {
	test("keeps only allowlisted Event fields", () => {
		const parsed = kubernetesEventSchema.parse(EVENT);
		expect(parsed.reason).toBe("CrashLoopBackOff");
		expect(JSON.stringify(parsed)).not.toContain("managedFields");
		expect(JSON.stringify(parsed)).not.toContain("related");
		expect(JSON.stringify(parsed)).not.toContain("db-creds");
	});

	test("bounds Event messages and list sizes", () => {
		expect(
			kubernetesEventSchema.safeParse({
				...EVENT,
				message: "x".repeat(5000),
			}).success,
		).toBe(false);
		expect(
			kubernetesEventListSchema.safeParse({
				items: Array.from({ length: KUBERNETES_MAX_ITEMS + 1 }, () => EVENT),
			}).success,
		).toBe(false);
		expect(
			kubernetesEventListSchema.safeParse({
				items: Array.from({ length: KUBERNETES_MAX_ITEMS }, () => EVENT),
			}).success,
		).toBe(true);
	});

	test("rejects too many labels and unbounded metadata", () => {
		const labels = Object.fromEntries(
			Array.from({ length: 65 }, (_, index) => [`label-${index}`, "x"]),
		);
		expect(
			kubernetesEventSchema.safeParse({
				...EVENT,
				metadata: { ...EVENT.metadata, labels },
			}).success,
		).toBe(false);
	});

	test("projects Pod status without spec dumps, IPs or node names", () => {
		const parsed = kubernetesPodSchema.parse({
			metadata: { name: "api-7c9f-abc", namespace: "payments" },
			spec: {
				nodeName: "node-internal-1",
				containers: [
					{
						name: "api",
						image: "api:v1",
						env: [{ name: "PASSWORD", value: "hunter2" }],
						resources: { limits: { memory: "128Mi" } },
					},
				],
			},
			status: {
				phase: "Running",
				podIP: "10.0.0.17",
				containerStatuses: [
					{
						name: "api",
						ready: false,
						restartCount: 9,
						lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
					},
				],
			},
		});
		const serialized = JSON.stringify(parsed);
		expect(serialized).not.toContain("node-internal-1");
		expect(serialized).not.toContain("10.0.0.17");
		expect(serialized).not.toContain("hunter2");
		expect(parsed.spec?.containers?.[0]?.resources?.limits?.memory).toBe(
			"128Mi",
		);
		expect(
			parsed.status?.containerStatuses?.[0]?.lastState?.terminated?.reason,
		).toBe("OOMKilled");
	});

	test("parses Deployment and ReplicaSet status bounds", () => {
		const deployment = kubernetesDeploymentSchema.parse({
			metadata: { name: "api", namespace: "payments", generation: 5 },
			spec: { replicas: 3, selector: { matchLabels: { app: "api" } } },
			status: {
				observedGeneration: 4,
				replicas: 4,
				readyReplicas: 1,
				availableReplicas: 1,
				unavailableReplicas: 2,
				conditions: [
					{
						type: "Available",
						status: "False",
						reason: "MinimumReplicasUnavailable",
					},
				],
			},
		});
		expect(deployment.status?.availableReplicas).toBe(1);
		expect(deployment.spec?.selector?.matchLabels).toEqual({ app: "api" });

		const replicaSets = kubernetesReplicaSetListSchema.parse({
			items: [
				{
					metadata: {
						name: "api-7c9f",
						namespace: "payments",
						annotations: { "deployment.kubernetes.io/revision": "3" },
					},
					spec: {
						replicas: 2,
						template: {
							spec: { containers: [{ name: "api", image: "api:v1" }] },
						},
					},
					status: { readyReplicas: 2 },
				},
			],
		});
		expect(replicaSets.items[0]?.metadata.annotations).toEqual({
			"deployment.kubernetes.io/revision": "3",
		});
		expect(replicaSets.items[0]?.status?.readyReplicas).toBe(2);
	});
});
