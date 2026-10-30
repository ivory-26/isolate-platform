import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { incidentSignalSchema } from "@isolate/shared";
import { localDemo } from "./caller-scope.server";
import {
	acceptIncident,
	buildIncidentGoal,
	createInMemoryIncidentDedupeStore,
	INCIDENT_DEDUPE_WINDOW_MS,
	type IncidentIntakeDependencies,
	type IncidentRepositoryRoute,
	UNTRUSTED_INCIDENT_NOTICE,
} from "./incident-intake.server";
import { harness, otherScope, scope, workflowPin } from "./test-fixtures";
import {
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_TIMESTAMP_HEADER,
} from "./webhook-signature.server";

const SECRET = "fabricated-webhook-secret-0123456789abcdef";
const NOW = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);

const signal = (overrides: Record<string, unknown> = {}) => ({
	source: "github",
	kind: "workflow_failed",
	severity: "high",
	service: "checkout-api",
	fingerprint: "repo:owner/checkout:run:42",
	title: "CI failed on main",
	summary: "The integration job failed after the deploy step.",
	links: [
		{
			label: "Failed run",
			url: "https://github.com/owner/checkout/actions/runs/42",
		},
	],
	receivedAt: "2026-10-30T12:00:00.000Z",
	...overrides,
});

const route: IncidentRepositoryRoute = {
	organizationId: scope.organizationId,
	repositoryId: localDemo.repositoryId,
	branch: "isolate/incident",
	workflowDefinitionId: workflowPin.workflowDefinitionId,
	workflowVersion: workflowPin.workflowVersion,
	fileOwnership: [],
};

type DeliveryOptions = {
	secret?: string;
	timestamp?: number;
	body?: string;
	signature?: string | null;
	timestampHeader?: string | null;
};

function delivery(
	payload: unknown,
	options: DeliveryOptions = {},
): { rawBody: string; headers: Headers; signature: string; timestamp: string } {
	const rawBody = options.body ?? JSON.stringify(payload);
	const timestamp = String(options.timestamp ?? NOW_SECONDS);
	const signature =
		options.signature === undefined
			? `sha256=${createHmac("sha256", options.secret ?? SECRET)
					.update(`${timestamp}.`)
					.update(rawBody)
					.digest("hex")}`
			: (options.signature ?? "");
	const headers = new Headers();
	const timestampHeader =
		options.timestampHeader === undefined ? timestamp : options.timestampHeader;
	if (timestampHeader !== null)
		headers.set(WEBHOOK_TIMESTAMP_HEADER, timestampHeader);
	if (options.signature !== null)
		headers.set(WEBHOOK_SIGNATURE_HEADER, signature);
	return { rawBody, headers, signature, timestamp };
}

function dependencies(
	h: ReturnType<typeof harness>,
	overrides: Partial<IncidentIntakeDependencies> = {},
): IncidentIntakeDependencies {
	return {
		signingSecret: SECRET,
		binding: {
			organizationId: scope.organizationId,
			userId: scope.userId,
			role: "member",
		},
		resolveRepository: async () => route,
		dedupe: createInMemoryIncidentDedupeStore(),
		submitTask: (input) => h.service.submit(input),
		now: () => new Date(NOW),
		...overrides,
	};
}

describe("acceptIncident", () => {
	test("creates exactly one bounded task through the submission service", async () => {
		const h = harness();
		const result = await acceptIncident(
			dependencies(h),
			delivery(signal(), { timestamp: NOW_SECONDS }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected acceptance");
		expect(result.deduped).toBe(false);
		expect(result.jobId).not.toBe(result.taskId);
		expect(h.tasks.calls).toHaveLength(1);
		const created = h.tasks.calls[0];
		if (created === undefined) throw new Error("Expected a task row");
		const goal = created.goal ?? "";
		expect(created.organizationId).toBe(scope.organizationId);
		expect(created.createdBy).toBe(scope.userId);
		expect(created.repositoryId).toBe(route.repositoryId);
		expect(goal.startsWith(UNTRUSTED_INCIDENT_NOTICE)).toBe(true);
		expect(goal).toContain("CI failed on main");
		expect(goal).toContain("The integration job failed");
		expect(goal).toContain("https://github.com/owner/checkout/actions/runs/42");
		expect(goal).toContain("untrusted data");
		expect(goal.length).toBeLessThanOrEqual(4000);
		expect(created.acceptanceCriteria).toEqual([]);
		expect(created.acceptanceChecks).toEqual([]);
		expect(created.fileOwnership).toEqual([]);
		const queued = h.queue.calls[0]?.payload as { taskId?: string } | undefined;
		expect(queued?.taskId).toBe(result.taskId);
		expect(h.queue.calls).toHaveLength(1);
	});

	test("keeps the goal bounded and the untrusted notice intact at the caps", () => {
		const goal = buildIncidentGoal(
			incidentSignalSchema.parse(
				signal({
					summary: "s".repeat(2000),
					links: Array.from({ length: 10 }, (_, index) => ({
						label: `run ${index}`,
						url: `https://example.com/${"x".repeat(480)}/${index}`,
					})),
				}),
			),
		);
		expect(goal.length).toBeLessThanOrEqual(4000);
		expect(goal.startsWith(UNTRUSTED_INCIDENT_NOTICE)).toBe(true);
	});

	test("dedupes a replay inside 30 minutes and accepts after the window", async () => {
		const h = harness();
		const deps = dependencies(h);
		const first = await acceptIncident(deps, delivery(signal()));
		if (!first.ok) throw new Error("Expected acceptance");
		const replay = await acceptIncident(deps, {
			...delivery(signal(), {
				timestamp: NOW_SECONDS + 29 * 60,
			}),
			now: NOW + 29 * 60 * 1000,
		});
		expect(replay).toEqual({
			ok: true,
			taskId: first.taskId,
			jobId: first.jobId,
			deduped: true,
		});
		expect(h.tasks.calls).toHaveLength(1);

		const after = await acceptIncident(deps, {
			...delivery(signal(), {
				timestamp: NOW_SECONDS + 30 * 60,
			}),
			now: NOW + INCIDENT_DEDUPE_WINDOW_MS,
		});
		expect(after.ok).toBe(true);
		if (!after.ok) throw new Error("Expected acceptance");
		expect(after.deduped).toBe(false);
		expect(h.tasks.calls).toHaveLength(2);
	});

	test("rejects a bad signature, stale timestamp and malformed headers", async () => {
		const h = harness();
		const deps = dependencies(h);
		const cases = [
			delivery(signal(), {
				secret: "another-fabricated-secret-0123456789abcdef",
			}),
			delivery(signal(), { timestamp: NOW_SECONDS - 301 }),
			delivery(signal(), { timestamp: NOW_SECONDS + 301 }),
			delivery(signal(), { signature: "not-a-signature" }),
			delivery(signal(), { signature: `sha256=${"a".repeat(64)}` }),
			delivery(signal(), { timestampHeader: null }),
			delivery(signal(), { signature: null }),
			delivery(signal(), { timestampHeader: "12x" }),
		];
		for (const request of cases)
			expect(await acceptIncident(deps, request)).toEqual({
				ok: false,
				code: "UNAUTHORIZED",
			});
		// Tampering with the body invalidates the signature over the raw bytes.
		const tampered = delivery(signal());
		expect(
			await acceptIncident(deps, {
				...tampered,
				rawBody: JSON.stringify(signal({ title: "different" })),
			}),
		).toEqual({ ok: false, code: "UNAUTHORIZED" });
		expect(h.tasks.calls).toHaveLength(0);
		expect(h.queue.calls).toHaveLength(0);
	});

	test("rejects a body above 64 KiB before parsing", async () => {
		const h = harness();
		const body = JSON.stringify(signal({ summary: "x".repeat(64 * 1024) }));
		const result = await acceptIncident(
			dependencies(h),
			delivery(signal(), { body }),
		);
		expect(result).toEqual({ ok: false, code: "PAYLOAD_TOO_LARGE" });
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("rejects malformed JSON and schema violations without touching storage", async () => {
		const h = harness();
		const deps = dependencies(h);
		expect(
			await acceptIncident(deps, delivery({}, { body: "{not json" })),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(
			await acceptIncident(deps, delivery(signal({ severity: "urgent" }))),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(
			await acceptIncident(deps, delivery(signal({ title: "t".repeat(201) }))),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("ignores body-supplied organization and repository fields", async () => {
		const h = harness();
		const deps = dependencies(h);
		const result = await acceptIncident(
			deps,
			delivery(
				signal({
					organizationId: otherScope.organizationId,
					repositoryId: crypto.randomUUID(),
					fileOwnership: ["**"],
				}),
			),
		);
		// Strict parsing rejects the attempt; no tenant selector from the body.
		expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("refuses a foreign repository mapping and treats a missing one as absent", async () => {
		const h = harness();
		const foreign = await acceptIncident(
			dependencies(h, {
				resolveRepository: async () => ({
					...route,
					organizationId: otherScope.organizationId,
				}),
			}),
			delivery(signal()),
		);
		expect(foreign).toEqual({ ok: false, code: "FORBIDDEN" });
		const missing = await acceptIncident(
			dependencies(h, { resolveRepository: async () => null }),
			delivery(signal()),
		);
		expect(missing).toEqual({ ok: false, code: "NOT_FOUND" });
		const malformed = await acceptIncident(
			dependencies(h, {
				resolveRepository: async () =>
					({ ...route, branch: "../main" }) as never,
			}),
			delivery(signal()),
		);
		expect(malformed).toEqual({ ok: false, code: "NOT_FOUND" });
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("resolves the repository with the binding tenant and signal service", async () => {
		const h = harness();
		const calls: Array<{ organizationId: string; service: string }> = [];
		await acceptIncident(
			dependencies(h, {
				resolveRepository: async (input) => {
					calls.push(input);
					return route;
				},
			}),
			delivery(signal()),
		);
		expect(calls).toEqual([
			{ organizationId: scope.organizationId, service: "checkout-api" },
		]);
	});

	test("applies route file ownership and an explicit budget", async () => {
		const h = harness();
		await acceptIncident(
			dependencies(h, {
				resolveRepository: async () => ({
					...route,
					fileOwnership: ["apps/checkout/**"],
					budget: { maxAgentTurns: 4, repairBudget: 1, jobTimeoutMs: 60_000 },
				}),
			}),
			delivery(signal()),
		);
		const created = h.tasks.calls[0];
		if (created === undefined) throw new Error("Expected a task row");
		expect(created.fileOwnership).toEqual(["apps/checkout/**"]);
		expect(created.budgetLimits).toEqual({
			maxAgentTurns: 4,
			maxRepairAttempts: 1,
			maxDurationMs: 60_000,
		});
	});

	test("fails closed for a viewer binding and a missing secret", async () => {
		const h = harness();
		expect(
			await acceptIncident(
				dependencies(h, {
					binding: {
						organizationId: scope.organizationId,
						userId: scope.userId,
						role: "viewer",
					},
				}),
				delivery(signal()),
			),
		).toEqual({ ok: false, code: "FORBIDDEN" });
		expect(
			await acceptIncident(
				dependencies(h, { signingSecret: undefined }),
				delivery(signal()),
			),
		).toEqual({ ok: false, code: "UNAVAILABLE" });
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("maps submission failures to bounded codes without detail", async () => {
		const h = harness();
		const result = await acceptIncident(
			dependencies(h, {
				submitTask: async () => ({
					ok: false,
					error: {
						code: "UNAVAILABLE",
						message: "private storage detail postgres://secret",
					},
				}),
			}),
			delivery(signal()),
		);
		expect(result).toEqual({ ok: false, code: "UNAVAILABLE" });
		expect(JSON.stringify(result)).not.toContain("private");
		expect(JSON.stringify(result)).not.toContain("postgres");
	});

	test("never logs or returns the secret, signature or payload", async () => {
		const h = harness();
		const request = delivery(signal({ summary: "payload-marker-9f3" }));
		const messages: string[] = [];
		const methods = ["log", "info", "warn", "error"] as const;
		const original = methods.map((method) => console[method]);
		for (const method of methods) {
			console[method] = (...args: unknown[]) => {
				messages.push(args.map((value) => String(value)).join(" "));
			};
		}
		let result: Awaited<ReturnType<typeof acceptIncident>> | undefined;
		try {
			result = await acceptIncident(dependencies(h), request);
		} finally {
			methods.forEach((method, index) => {
				console[method] = original[index];
			});
		}
		if (result === undefined) throw new Error("Expected a result");
		const serialized = JSON.stringify(result);
		for (const secret of [SECRET, request.signature, "payload-marker-9f3"])
			expect(serialized).not.toContain(secret);
		const logged = messages.join("\n");
		for (const secret of [SECRET, request.signature, "payload-marker-9f3"])
			expect(logged).not.toContain(secret);
		expect(messages).toHaveLength(0);
	});
});

describe("in-memory dedupe store", () => {
	test("expires entries at the window boundary", async () => {
		const store = createInMemoryIncidentDedupeStore();
		const key = {
			organizationId: scope.organizationId,
			source: "github" as const,
			fingerprint: "fp",
		};
		await store.save(key, {
			taskId: crypto.randomUUID(),
			jobId: crypto.randomUUID(),
			acceptedAtMs: NOW,
		});
		expect(
			await store.lookup(key, NOW + INCIDENT_DEDUPE_WINDOW_MS - 1),
		).not.toBeNull();
		expect(await store.lookup(key, NOW + INCIDENT_DEDUPE_WINDOW_MS)).toBeNull();
	});

	test("is keyed by organization, source and fingerprint", async () => {
		const store = createInMemoryIncidentDedupeStore();
		const entry = {
			taskId: crypto.randomUUID(),
			jobId: crypto.randomUUID(),
			acceptedAtMs: NOW,
		};
		await store.save(
			{
				organizationId: scope.organizationId,
				source: "github",
				fingerprint: "fp",
			},
			entry,
		);
		expect(
			await store.lookup(
				{
					organizationId: otherScope.organizationId,
					source: "github",
					fingerprint: "fp",
				},
				NOW,
			),
		).toBeNull();
		expect(
			await store.lookup(
				{
					organizationId: scope.organizationId,
					source: "sentry",
					fingerprint: "fp",
				},
				NOW,
			),
		).toBeNull();
	});
});
