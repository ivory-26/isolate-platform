import { describe, expect, test } from "bun:test";
import { incidentSignalSchema } from "@isolate/shared";
import {
	kubernetesIncidentFingerprint,
	kubernetesSeverityForReason,
	normalizeKubernetesEvent,
} from "./normalize";

const NAMESPACE = "payments";
const POD = "api-7c9f-abc";
const RECEIVED_AT = "2026-10-31T00:00:00.000Z";

type EventOverrides = {
	reason?: string;
	type?: string;
	message?: string;
	count?: number;
	podName?: string;
	namespace?: string;
};

function event(overrides: EventOverrides = {}) {
	return {
		metadata: {
			name: "api.7c9f",
			namespace: overrides.namespace ?? NAMESPACE,
			uid: "event-uid-1",
			resourceVersion: "99",
			creationTimestamp: "2026-10-30T23:00:00Z",
		},
		involvedObject: {
			apiVersion: "v1",
			kind: "Pod",
			name: overrides.podName ?? POD,
			namespace: overrides.namespace ?? NAMESPACE,
			uid: "pod-uid-1",
			resourceVersion: "12345",
		},
		reason: overrides.reason ?? "CrashLoopBackOff",
		message:
			overrides.message ??
			"Back-off restarting failed container api in pod api-7c9f-abc",
		type: overrides.type ?? "Warning",
		count: overrides.count ?? 7,
		firstTimestamp: "2026-10-30T23:00:00Z",
		lastTimestamp: "2026-10-30T23:30:00Z",
	};
}

const BASE_OPTIONS = {
	cluster: "prod-eu",
	labels: { "app.kubernetes.io/name": "api" },
	receivedAt: RECEIVED_AT,
} as const;

describe("normalizeKubernetesEvent", () => {
	test("maps CrashLoopBackOff to high in production with an owner-based key", () => {
		const signal = normalizeKubernetesEvent(event(), {
			...BASE_OPTIONS,
			production: true,
			owner: { kind: "Deployment", name: "api" },
		});
		expect(signal).not.toBeNull();
		if (signal === null) return;
		expect(incidentSignalSchema.safeParse(signal).success).toBe(true);
		expect(signal.source).toBe("kubernetes");
		expect(signal.kind).toBe("pod_crashloop");
		expect(signal.severity).toBe("high");
		expect(signal.service).toBe("api");
		expect(signal.fingerprint).toBe(
			"k8s:prod-eu:payments:deployment/api:CrashLoopBackOff",
		);
		expect(signal.receivedAt).toBe(RECEIVED_AT);
		expect(signal.summary).toContain("Owner: Deployment/api");
		expect(signal.links).toEqual([]);
	});

	test("keeps the fingerprint stable across a pod-hash change", () => {
		const first = normalizeKubernetesEvent(event({ podName: "api-7c9f-abc" }), {
			...BASE_OPTIONS,
			owner: { kind: "Deployment", name: "api" },
		});
		const second = normalizeKubernetesEvent(
			event({ podName: "api-8d2e-xyz" }),
			{ ...BASE_OPTIONS, owner: { kind: "Deployment", name: "api" } },
		);
		expect(first?.fingerprint).toBe(second?.fingerprint);
		// Without the owner the concrete pod is the key component.
		expect(
			normalizeKubernetesEvent(event({ podName: "api-7c9f-abc" }), BASE_OPTIONS)
				?.fingerprint,
		).toBe("k8s:prod-eu:payments:pod/api-7c9f-abc:CrashLoopBackOff");
	});

	test("raises OOMKilled to critical in production and high otherwise", () => {
		expect(
			normalizeKubernetesEvent(event({ reason: "OOMKilled" }), {
				...BASE_OPTIONS,
				production: true,
			})?.severity,
		).toBe("critical");
		expect(
			normalizeKubernetesEvent(event({ reason: "OOMKilled" }), BASE_OPTIONS)
				?.severity,
		).toBe("high");
		expect(
			normalizeKubernetesEvent(event({ reason: "OOMKilled" }), BASE_OPTIONS)
				?.kind,
		).toBe("pod_oomkilled");
	});

	test("maps FailedScheduling to medium and image-pull reasons to high", () => {
		const scheduling = normalizeKubernetesEvent(
			event({ reason: "FailedScheduling" }),
			BASE_OPTIONS,
		);
		expect(scheduling?.kind).toBe("pod_scheduling_failed");
		expect(scheduling?.severity).toBe("medium");

		for (const reason of [
			"ErrImagePull",
			"ImagePullBackOff",
			"InvalidImageName",
		]) {
			const signal = normalizeKubernetesEvent(event({ reason }), BASE_OPTIONS);
			expect(signal?.kind).toBe("image_pull_failed");
			expect(signal?.severity).toBe("high");
			expect(signal?.fingerprint).toContain(":ImagePull");
		}
	});

	test("drops Normal events and maps unknown Warnings to medium", () => {
		expect(
			normalizeKubernetesEvent(event({ type: "Normal" }), BASE_OPTIONS),
		).toBeNull();
		const unknown = normalizeKubernetesEvent(
			event({ reason: "SomeNewReason" }),
			BASE_OPTIONS,
		);
		expect(unknown?.kind).toBe("kubernetes_warning");
		expect(unknown?.severity).toBe("medium");
		expect(unknown?.fingerprint).toContain(":SomeNewReason");
	});

	test("falls back to the namespace as the service", () => {
		const signal = normalizeKubernetesEvent(event(), {
			cluster: "prod-eu",
			receivedAt: RECEIVED_AT,
		});
		expect(signal?.service).toBe(NAMESPACE);
	});

	test("exposes a display link only when configured, never the API URL", () => {
		const withoutDisplay = normalizeKubernetesEvent(event(), BASE_OPTIONS);
		expect(JSON.stringify(withoutDisplay)).not.toContain("kubernetes.default");
		expect(withoutDisplay?.links).toEqual([]);

		const withDisplay = normalizeKubernetesEvent(event(), {
			...BASE_OPTIONS,
			displayUrl: "https://ops.example.com/clusters/prod-eu",
		});
		expect(withDisplay?.links).toEqual([
			{
				label: `Pod/${POD}`,
				url: `https://ops.example.com/clusters/prod-eu/payments/pod/${POD}`,
			},
		]);
		expect(JSON.stringify(withDisplay)).not.toContain("kubernetes.default");
	});

	test("redacts tokens, passwords, JWTs and emails before summarising", () => {
		const signal = normalizeKubernetesEvent(
			event({
				message:
					"Authorization: Bearer ghs_secretvalue123 password=hunter2 ops@example.com <jwt-redacted>",
			}),
			BASE_OPTIONS,
		);
		const summary = signal?.summary ?? "";
		expect(summary).not.toContain("ghs_secretvalue123");
		expect(summary).not.toContain("hunter2");
		expect(summary).not.toContain("ops@example.com");
		expect(summary).not.toContain(
			"<jwt-redacted>",
		);
		expect(summary.length).toBeLessThanOrEqual(2000);
		expect(signal?.title.length).toBeLessThanOrEqual(200);
	});

	test("returns null for malformed events and unknown namespaces", () => {
		expect(normalizeKubernetesEvent(null, BASE_OPTIONS)).toBeNull();
		expect(normalizeKubernetesEvent({ metadata: {} }, BASE_OPTIONS)).toBeNull();
		expect(
			normalizeKubernetesEvent(
				{
					metadata: { name: "e" },
					involvedObject: { kind: "Pod", name: POD },
					reason: "CrashLoopBackOff",
					type: "Warning",
				},
				BASE_OPTIONS,
			),
		).toBeNull();
	});
});

describe("kubernetesIncidentFingerprint", () => {
	test("keeps the documented shape and bounds long components", () => {
		expect(
			kubernetesIncidentFingerprint({
				cluster: "prod:eu",
				namespace: NAMESPACE,
				kind: "Pod",
				name: POD,
				reason: "CrashLoopBackOff",
			}),
		).toBe("k8s:prod_eu:payments:pod/api-7c9f-abc:CrashLoopBackOff");

		const long = kubernetesIncidentFingerprint({
			cluster: "c".repeat(100),
			namespace: NAMESPACE,
			kind: "Deployment",
			name: "d".repeat(200),
			reason: "R".repeat(100),
		});
		expect(long.length).toBeLessThanOrEqual(128);
		expect(long).toContain("~");
	});
});

describe("kubernetesSeverityForReason", () => {
	test("uses the production band only when asked", () => {
		expect(kubernetesSeverityForReason("CrashLoopBackOff")).toBe("medium");
		expect(
			kubernetesSeverityForReason("CrashLoopBackOff", { production: true }),
		).toBe("high");
		expect(kubernetesSeverityForReason("OOMKilled", { production: true })).toBe(
			"critical",
		);
		expect(kubernetesSeverityForReason(undefined)).toBe("medium");
	});
});
