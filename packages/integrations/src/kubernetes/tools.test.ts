import { describe, expect, test } from "bun:test";
import type { PlatformError } from "@isolate/shared";
import type { KubernetesContextDependencies } from "./context";
import {
	createKubernetesReadTools,
	KUBERNETES_OUT_OF_SCOPE_TOOLS,
	KUBERNETES_READ_TOOL_RISK,
	KUBERNETES_READ_TOOLS,
	k8sGetPodInputSchema,
	k8sListEventsInputSchema,
	k8sLogsTailInputSchema,
} from "./tools";
import type {
	KubernetesHttpClient,
	KubernetesJsonResult,
	KubernetesQuery,
	KubernetesTextResult,
} from "./types";

const NAMESPACE = "payments";
const POD = "api-7c9f-abc";

type Call = {
	method: "get" | "getText";
	path: string;
	query: KubernetesQuery | undefined;
};

function fakeClient(routes: {
	pod?: KubernetesJsonResult;
	events?: KubernetesJsonResult;
	log?: KubernetesTextResult;
}): { client: KubernetesHttpClient; calls: Call[] } {
	const calls: Call[] = [];
	const client: KubernetesHttpClient = {
		async get(path, query) {
			calls.push({ method: "get", path, query });
			if (path.endsWith("/events")) {
				return routes.events ?? { status: 200, body: { items: [] } };
			}
			if (path.includes("/pods/")) {
				return (
					routes.pod ?? {
						status: 200,
						body: {
							metadata: { name: POD, namespace: NAMESPACE },
							status: {
								phase: "Running",
								containerStatuses: [
									{ name: "api", ready: true, restartCount: 0 },
								],
							},
						},
					}
				);
			}
			return { status: 404, body: {} };
		},
		async getText(path, query) {
			calls.push({ method: "getText", path, query });
			return routes.log ?? { status: 200, text: "line 1\nline 2\n" };
		},
	};
	return { client, calls };
}

function deps(client: KubernetesHttpClient): KubernetesContextDependencies {
	return {
		client,
		namespace: NAMESPACE,
		clusterId: "prod-eu",
		now: () => Date.parse("2026-10-31T00:00:00.000Z"),
	};
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (thrown) {
		return thrown;
	}
	return undefined;
}

describe("kubernetes read-only tool surface", () => {
	test("exposes exactly four read_only tools", () => {
		const { client } = fakeClient({});
		const tools = createKubernetesReadTools(deps(client));
		expect(tools.map((tool) => tool.name)).toEqual([
			"k8s.list_events",
			"k8s.get_pod",
			"k8s.get_deployment",
			"k8s.logs_tail",
		]);
		expect(tools.map((tool) => tool.name)).toEqual([...KUBERNETES_READ_TOOLS]);
		for (const tool of tools) {
			expect(tool.risk).toBe(KUBERNETES_READ_TOOL_RISK);
			expect(tool.description.length).toBeGreaterThan(0);
		}
	});

	test("rejects unknown keys, unbounded tails and path-like names", () => {
		expect(
			k8sListEventsInputSchema.safeParse({
				namespace: NAMESPACE,
				name: POD,
				follow: true,
			}).success,
		).toBe(false);
		for (const args of [
			{ namespace: NAMESPACE, podName: POD, follow: true },
			{ namespace: NAMESPACE, podName: POD, tailLines: 201 },
			{ namespace: NAMESPACE, podName: POD, tailLines: 0 },
			{ namespace: NAMESPACE, podName: POD, sinceSeconds: 59 },
			{ namespace: NAMESPACE, podName: POD, container: "Bad/Name" },
			{ namespace: NAMESPACE, podName: "../api" },
			{ namespace: "Bad/NS", podName: POD },
		]) {
			expect(k8sLogsTailInputSchema.safeParse(args).success).toBe(false);
		}
		expect(
			k8sGetPodInputSchema.safeParse({ namespace: NAMESPACE, name: "api_pod" })
				.success,
		).toBe(false);
		expect(
			k8sGetPodInputSchema.safeParse({ namespace: NAMESPACE, name: POD })
				.success,
		).toBe(true);
	});

	test("returns NOT_FOUND for a foreign namespace without an API call", async () => {
		const { client, calls } = fakeClient({});
		const [listEvents] = createKubernetesReadTools(deps(client));
		const error = await failureOf(() =>
			listEvents?.execute({ namespace: "other", name: POD }),
		);
		expect((error as PlatformError).code).toBe("NOT_FOUND");
		expect(calls).toHaveLength(0);
	});

	test("maps an explicit 404 to NOT_FOUND and a 403 to POLICY_DENIED", async () => {
		for (const [status, code] of [
			[404, "NOT_FOUND"],
			[403, "POLICY_DENIED"],
		] as const) {
			const { client } = fakeClient({ pod: { status, body: {} } });
			const tools = createKubernetesReadTools(deps(client));
			const getPod = tools.find((tool) => tool.name === "k8s.get_pod");
			expect(getPod).toBeDefined();
			const error = await failureOf(() =>
				getPod === undefined
					? Promise.resolve(undefined)
					: getPod.execute({ namespace: NAMESPACE, name: POD }),
			);
			expect((error as PlatformError).code).toBe(code);
		}
	});

	test("bounds list_events to the requested limit and never all namespaces", async () => {
		const { client, calls } = fakeClient({
			events: {
				status: 200,
				body: {
					items: Array.from({ length: 12 }, (_, index) => ({
						metadata: { name: `e-${index}`, namespace: NAMESPACE },
						involvedObject: {
							kind: "Pod",
							name: POD,
							namespace: NAMESPACE,
						},
						reason: "CrashLoopBackOff",
						message: "back-off",
						type: "Warning",
					})),
				},
			},
		});
		const listEvents = createKubernetesReadTools(deps(client)).find(
			(tool) => tool.name === "k8s.list_events",
		);
		const result = await listEvents?.execute({
			namespace: NAMESPACE,
			name: POD,
			limit: 3,
		});
		const items = result?.items as Array<{ excerpt: string }>;
		expect(items[0]?.excerpt.split("\n")).toHaveLength(3);
		expect(calls[0]?.path).toBe("/api/v1/namespaces/payments/events");
		expect(calls[0]?.query?.limit).toBe("50");
	});

	test("returns a redacted, capped log tail with no follow parameter", async () => {
		const longTail = Array.from(
			{ length: 250 },
			(_, index) => `line ${index} password=hunter2 token=abc`,
		).join("\n");
		const { client, calls } = fakeClient({
			log: { status: 200, text: longTail },
		});
		const logsTail = createKubernetesReadTools(deps(client)).find(
			(tool) => tool.name === "k8s.logs_tail",
		);
		const result = await logsTail?.execute({
			namespace: NAMESPACE,
			podName: POD,
			container: "api",
			tailLines: 10,
			sinceSeconds: 120,
		});
		const items = result?.items as Array<{ excerpt: string }>;
		expect(items[0]?.excerpt.length).toBeLessThanOrEqual(2000);
		expect(items[0]?.excerpt).not.toContain("hunter2");
		expect(result?.truncated).toBe(true);
		expect(calls[0]?.path).toBe(`/api/v1/namespaces/payments/pods/${POD}/log`);
		expect(calls[0]?.query).toEqual({
			tailLines: "10",
			timestamps: "true",
			sinceSeconds: "120",
			container: "api",
		});
		expect(calls[0]?.query).not.toHaveProperty("follow");
	});

	test("documents but never implements destructive or sensitive actions", () => {
		const names: readonly string[] = KUBERNETES_OUT_OF_SCOPE_TOOLS.map(
			(tool) => tool.name,
		);
		for (const name of ["k8s.delete", "k8s.exec", "k8s.scale", "k8s.apply"]) {
			expect(names).toContain(name);
		}
		for (const tool of KUBERNETES_OUT_OF_SCOPE_TOOLS) {
			expect(["sensitive", "destructive"]).toContain(tool.risk);
			expect("execute" in tool).toBe(false);
			expect("inputSchema" in tool).toBe(false);
		}
		const { client } = fakeClient({});
		const implemented = createKubernetesReadTools(deps(client)).map(
			(tool) => tool.name as string,
		);
		for (const name of names) {
			expect(implemented).not.toContain(name);
		}
	});
});
