import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type {
	CountActiveIncidentTasksInput,
	IncidentRepository,
	IncidentSignalInput,
} from "@isolate/db";
import { incidentSignalSchema } from "@isolate/shared";
import { localDemo } from "./caller-scope.server";
import {
	acceptIncident,
	buildIncidentGoal,
	createInMemoryIncidentDedupeStore,
	detectIncidentIntakeMode,
	evaluateIncidentTrigger,
	githubIncidentOnDefaultBranch,
	INCIDENT_DEDUPE_WINDOW_MS,
	INCIDENT_TASK_CAP_WINDOW_MS,
	type IncidentIntakeDependencies,
	type IncidentRepositoryRoute,
	MAX_ACTIVE_INCIDENT_TASKS,
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
		if (!result.ok || !("taskId" in result)) {
			throw new Error("Expected a created task");
		}
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
		if (!first.ok || !("taskId" in first)) {
			throw new Error("Expected a created task");
		}
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

const GITHUB_SECRET = "fabricated-github-webhook-secret-0123456789";
const HEAD_SHA = "a".repeat(40);

type WorkflowPayloadOptions = {
	action?: string;
	defaultBranch?: string;
	headBranch?: string;
	conclusion?: string;
	name?: string;
	environment?: string;
};

function workflowPayload(options: WorkflowPayloadOptions = {}) {
	return {
		action: options.action ?? "completed",
		repository: {
			name: "checkout-api",
			full_name: "owner/checkout-api",
			default_branch: options.defaultBranch ?? "main",
			html_url: "https://github.com/owner/checkout-api",
		},
		workflow_run: {
			id: 42,
			name: options.name ?? "CI",
			head_branch: options.headBranch ?? "main",
			head_sha: HEAD_SHA,
			conclusion: options.conclusion ?? "failure",
			html_url: "https://github.com/owner/checkout-api/actions/runs/42",
			...(options.environment === undefined
				? {}
				: { environment: { name: options.environment } }),
		},
	};
}

type GitHubDeliveryOptions = {
	secret?: string;
	event?: string;
	delivery?: string;
	body?: string;
	signature?: string | null;
};

function githubDelivery(
	payload: unknown,
	options: GitHubDeliveryOptions = {},
): { rawBody: string; headers: Headers } {
	const rawBody = options.body ?? JSON.stringify(payload);
	const signature =
		options.signature === undefined
			? `sha256=${createHmac("sha256", options.secret ?? GITHUB_SECRET)
					.update(rawBody)
					.digest("hex")}`
			: options.signature;
	const headers = new Headers();
	headers.set("x-github-event", options.event ?? "workflow_run");
	headers.set("x-github-delivery", options.delivery ?? "delivery-1");
	if (signature !== null) headers.set("x-hub-signature-256", signature);
	return { rawBody, headers };
}

/** Fake signal store: shares the dedupe bucket and records every call. */
function incidentRepository(
	options: { active?: number; duplicate?: boolean; fail?: boolean } = {},
) {
	const signalCalls: IncidentSignalInput[] = [];
	const capCalls: CountActiveIncidentTasksInput[] = [];
	const recorded = new Set<string>();
	const repository: IncidentRepository = {
		async recordIfNew(input) {
			signalCalls.push(input);
			if (options.fail === true) throw new Error("private signal store detail");
			const key = `${input.organizationId}:${input.source}:${input.fingerprint}:${Math.floor(
				(input.receivedAt ?? new Date(NOW)).getTime() /
					INCIDENT_DEDUPE_WINDOW_MS,
			)}`;
			if (options.duplicate === true || recorded.has(key))
				return { ok: true, signalId: "signal-surviving", created: false };
			recorded.add(key);
			return { ok: true, signalId: crypto.randomUUID(), created: true };
		},
		async countActiveIncidentTasks(input) {
			capCalls.push(input);
			if (options.fail === true) throw new Error("private cap detail");
			return options.active ?? 0;
		},
	};
	return { repository, signalCalls, capCalls };
}

function githubDependencies(
	h: ReturnType<typeof harness>,
	options: {
		active?: number;
		duplicate?: boolean;
		fail?: boolean;
		store?: ReturnType<typeof incidentRepository>;
		overrides?: Partial<IncidentIntakeDependencies>;
	} = {},
) {
	const store = options.store ?? incidentRepository(options);
	const deps = dependencies(h, {
		githubSecret: GITHUB_SECRET,
		incidentRepository: store.repository,
		...options.overrides,
	});
	return { deps, store };
}

function createdTask(result: Awaited<ReturnType<typeof acceptIncident>>): {
	taskId: string;
	jobId: string;
	deduped: boolean;
} {
	if (!result.ok || !("taskId" in result))
		throw new Error("Expected a created task");
	return result;
}

describe("mode selection", () => {
	test("chooses GitHub only for a delivery carrying x-github-event", () => {
		expect(
			detectIncidentIntakeMode(githubDelivery(workflowPayload()).headers),
		).toBe("github");
		expect(detectIncidentIntakeMode(delivery(signal()).headers)).toBe(
			"generic",
		);
		expect(detectIncidentIntakeMode({})).toBe("generic");
		expect(detectIncidentIntakeMode({ "x-github-event": "  " })).toBe(
			"generic",
		);
	});

	test("fails closed with 503 when the detected mode has no secret", async () => {
		const h = harness();
		const github = githubDependencies(h, {
			overrides: { githubSecret: undefined },
		});
		expect(
			await acceptIncident(github.deps, githubDelivery(workflowPayload())),
		).toEqual({ ok: false, code: "UNAVAILABLE" });
		const generic = dependencies(h, { signingSecret: undefined });
		expect(await acceptIncident(generic, delivery(signal()))).toEqual({
			ok: false,
			code: "UNAVAILABLE",
		});
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("rejects a GitHub delivery signed with another secret or header set", async () => {
		const h = harness();
		const { deps } = githubDependencies(h);
		const cases = [
			githubDelivery(workflowPayload(), { secret: SECRET }),
			githubDelivery(workflowPayload(), {
				signature: `sha256=${"a".repeat(64)}`,
			}),
			githubDelivery(workflowPayload(), {
				signature: `sha1=${"a".repeat(40)}`,
			}),
			githubDelivery(workflowPayload(), { signature: "not-a-signature" }),
			githubDelivery(workflowPayload(), { signature: null }),
		];
		for (const request of cases)
			expect(await acceptIncident(deps, request)).toEqual({
				ok: false,
				code: "UNAUTHORIZED",
			});
		// The GitHub secret never verifies a generic (timestamped) delivery.
		expect(
			await acceptIncident(
				dependencies(h, { signingSecret: GITHUB_SECRET }),
				delivery(signal()),
			),
		).toEqual({ ok: false, code: "UNAUTHORIZED" });
		expect(h.tasks.calls).toHaveLength(0);
	});
});

describe("trigger policy", () => {
	const table = [
		{
			severity: "critical",
			production: true,
			onDefaultBranch: false,
			decision: { accepted: true, severity: "critical" },
		},
		{
			severity: "critical",
			production: true,
			onDefaultBranch: true,
			decision: { accepted: true, severity: "critical" },
		},
		{
			severity: "critical",
			production: false,
			onDefaultBranch: true,
			decision: { accepted: false, reason: "production" },
		},
		{
			severity: "high",
			production: false,
			onDefaultBranch: true,
			decision: { accepted: true, severity: "high" },
		},
		{
			severity: "high",
			production: false,
			onDefaultBranch: false,
			decision: { accepted: false, reason: "branch" },
		},
		{
			severity: "high",
			production: true,
			onDefaultBranch: false,
			decision: { accepted: false, reason: "branch" },
		},
		{
			severity: "medium",
			production: true,
			onDefaultBranch: true,
			decision: { accepted: false, reason: "severity" },
		},
		{
			severity: "low",
			production: true,
			onDefaultBranch: true,
			decision: { accepted: false, reason: "severity" },
		},
		{
			severity: "info",
			production: true,
			onDefaultBranch: true,
			decision: { accepted: false, reason: "severity" },
		},
	] as const;

	test("accepts only critical-with-production and high-on-default", () => {
		for (const row of table)
			expect(
				evaluateIncidentTrigger({
					severity: row.severity,
					production: row.production,
					onDefaultBranch: row.onDefaultBranch,
				}),
			).toEqual(row.decision);
	});

	test("reads the default branch from the delivery, never from a claim", () => {
		expect(
			githubIncidentOnDefaultBranch({
				name: "workflow_run",
				payload: workflowPayload({ defaultBranch: "main", headBranch: "main" }),
			}),
		).toBe(true);
		expect(
			githubIncidentOnDefaultBranch({
				name: "workflow_run",
				payload: workflowPayload({
					defaultBranch: "main",
					headBranch: "feature/x",
				}),
			}),
		).toBe(false);
		expect(
			githubIncidentOnDefaultBranch({
				name: "workflow_run",
				payload: workflowPayload({
					defaultBranch: "develop",
					headBranch: "develop",
				}),
			}),
		).toBe(true);
		expect(
			githubIncidentOnDefaultBranch({
				name: "push",
				payload: workflowPayload(),
			}),
		).toBe(false);
		expect(
			githubIncidentOnDefaultBranch({ name: "workflow_run", payload: null }),
		).toBe(false);
		expect(
			githubIncidentOnDefaultBranch({ name: "workflow_run", payload: {} }),
		).toBe(false);
	});
});

describe("github delivery", () => {
	test("creates one incident task with provenance and a bounded untrusted goal", async () => {
		const h = harness();
		const { deps, store } = githubDependencies(h);
		const request = githubDelivery(workflowPayload(), {
			delivery: "delivery-42",
		});
		const result = createdTask(await acceptIncident(deps, request));
		expect(result.deduped).toBe(false);
		expect(h.tasks.calls).toHaveLength(1);
		const task = h.tasks.calls[0];
		if (task === undefined) throw new Error("Expected a task row");
		expect(task.incidentSource).toBe("github");
		expect(task.incidentFingerprint).toBe("github:owner/checkout-api:CI:main");
		expect(task.acceptanceCriteria).toEqual([]);
		expect(task.acceptanceChecks).toEqual([]);
		expect(task.goal?.startsWith(UNTRUSTED_INCIDENT_NOTICE)).toBe(true);
		expect(task.goal).toContain('Workflow "CI" failed on main');
		expect(task.goal).toContain(
			"https://github.com/owner/checkout-api/actions/runs/42",
		);
		expect(task.goal?.length).toBeLessThanOrEqual(4000);
		expect(store.signalCalls).toHaveLength(1);
		const recorded = store.signalCalls[0];
		if (recorded === undefined) throw new Error("Expected a signal row");
		expect(recorded.organizationId).toBe(scope.organizationId);
		expect(recorded.source).toBe("github");
		expect(recorded.kind).toBe("workflow_failed");
		expect(recorded.severity).toBe("critical");
		expect(recorded.service).toBe("checkout-api");
		expect(recorded.deliveryId).toBe("delivery-42");
		expect(recorded.receivedAt?.getTime()).toBe(NOW);
		expect(store.capCalls).toHaveLength(1);
		const cap = store.capCalls[0];
		expect(cap?.organizationId).toBe(scope.organizationId);
		expect(cap?.sources).toEqual(["github"]);
		expect(cap?.since.getTime()).toBe(NOW - INCIDENT_TASK_CAP_WINDOW_MS);
	});

	test("accepts a production environment off the default branch", async () => {
		const h = harness();
		const { deps } = githubDependencies(h);
		const result = createdTask(
			await acceptIncident(
				deps,
				githubDelivery(
					workflowPayload({
						headBranch: "release/1.2",
						environment: "production",
					}),
				),
			),
		);
		expect(result.deduped).toBe(false);
		expect(h.tasks.calls).toHaveLength(1);
	});

	test("accepts high on a non-production default branch", async () => {
		const h = harness();
		const { deps, store } = githubDependencies(h);
		await acceptIncident(
			deps,
			githubDelivery(
				workflowPayload({ defaultBranch: "develop", headBranch: "develop" }),
			),
		);
		expect(store.signalCalls[0]?.severity).toBe("high");
		expect(h.tasks.calls).toHaveLength(1);
	});

	test("returns accepted:false for non-triggering deliveries and writes nothing", async () => {
		const cases = [
			workflowPayload({ headBranch: "feature/x" }),
			workflowPayload({ conclusion: "success" }),
			workflowPayload({ action: "requested" }),
			{ repository: { name: "checkout-api" }, hello: "world" },
		];
		for (const payload of cases) {
			const h = harness();
			const { deps, store } = githubDependencies(h);
			expect(await acceptIncident(deps, githubDelivery(payload))).toEqual({
				ok: true,
				accepted: false,
				deduped: false,
				throttled: false,
			});
			expect(store.signalCalls).toHaveLength(0);
			expect(store.capCalls).toHaveLength(0);
			expect(h.tasks.calls).toHaveLength(0);
			expect(h.queue.calls).toHaveLength(0);
		}
		// An unsupported event type is not an incident either.
		const h = harness();
		const { deps, store } = githubDependencies(h);
		expect(
			await acceptIncident(
				deps,
				githubDelivery(workflowPayload(), { event: "push" }),
			),
		).toEqual({ ok: true, accepted: false, deduped: false, throttled: false });
		expect(store.signalCalls).toHaveLength(0);
	});

	test("rejects malformed JSON after a valid signature without writing", async () => {
		const h = harness();
		const { deps, store } = githubDependencies(h);
		expect(
			await acceptIncident(deps, githubDelivery(null, { body: "{not json" })),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(store.signalCalls).toHaveLength(0);
		expect(h.tasks.calls).toHaveLength(0);
	});
});

describe("github dedupe and cap", () => {
	test("a redelivery inside the window reuses the task and writes nothing", async () => {
		const h = harness();
		const { deps, store } = githubDependencies(h);
		const first = createdTask(
			await acceptIncident(deps, githubDelivery(workflowPayload())),
		);
		const replay = createdTask(
			await acceptIncident(
				deps,
				githubDelivery(workflowPayload(), { delivery: "delivery-2" }),
			),
		);
		expect(replay).toEqual({ ...first, deduped: true });
		expect(h.tasks.calls).toHaveLength(1);
		expect(store.signalCalls).toHaveLength(1);
		expect(store.capCalls).toHaveLength(1);
	});

	test("a surviving signal row dedupes after the in-process store is lost", async () => {
		const h = harness();
		const shared = incidentRepository();
		const first = createdTask(
			await acceptIncident(
				githubDependencies(h, { store: shared }).deps,
				githubDelivery(workflowPayload()),
			),
		);
		// Simulate a restart: new in-memory store, same surviving signal row.
		const restarted = githubDependencies(h, { store: shared });
		expect(
			await acceptIncident(restarted.deps, githubDelivery(workflowPayload())),
		).toEqual({
			ok: true,
			accepted: false,
			deduped: true,
			throttled: false,
		});
		// The cap is consulted once, for the first delivery only.
		expect(restarted.store.capCalls).toHaveLength(1);
		expect(h.tasks.calls).toHaveLength(1);
		expect(first.deduped).toBe(false);
	});

	test("opens a new task after the dedupe window closes", async () => {
		const h = harness();
		const { deps } = githubDependencies(h);
		createdTask(await acceptIncident(deps, githubDelivery(workflowPayload())));
		const later = createdTask(
			await acceptIncident(deps, {
				...githubDelivery(workflowPayload(), { delivery: "delivery-3" }),
				now: NOW + INCIDENT_DEDUPE_WINDOW_MS + 60_000,
			}),
		);
		expect(later.deduped).toBe(false);
		expect(h.tasks.calls).toHaveLength(2);
	});

	test("throttles at the per-org cap without creating a task", async () => {
		const h = harness();
		const { deps, store } = githubDependencies(h, {
			active: MAX_ACTIVE_INCIDENT_TASKS,
		});
		expect(
			await acceptIncident(deps, githubDelivery(workflowPayload())),
		).toEqual({ ok: true, accepted: false, deduped: false, throttled: true });
		// The signal is recorded before the cap, so a replay is deduped, not retried.
		expect(store.signalCalls).toHaveLength(1);
		expect(h.tasks.calls).toHaveLength(0);
		expect(h.queue.calls).toHaveLength(0);

		const below = harness();
		const allowed = githubDependencies(below, {
			active: MAX_ACTIVE_INCIDENT_TASKS - 1,
		});
		createdTask(
			await acceptIncident(allowed.deps, githubDelivery(workflowPayload())),
		);
		expect(below.tasks.calls).toHaveLength(1);
	});

	test("fails closed when the signal store is absent or errors", async () => {
		const h = harness();
		const absent = githubDependencies(h, {
			overrides: { incidentRepository: null },
		});
		expect(
			await acceptIncident(absent.deps, githubDelivery(workflowPayload())),
		).toEqual({ ok: false, code: "UNAVAILABLE" });
		const failing = githubDependencies(h, { fail: true });
		expect(
			await acceptIncident(failing.deps, githubDelivery(workflowPayload())),
		).toEqual({ ok: false, code: "UNAVAILABLE" });
		expect(h.tasks.calls).toHaveLength(0);
	});
});

describe("github hygiene", () => {
	test("never logs or returns the secret, signature or payload text", async () => {
		const h = harness();
		const { deps } = githubDependencies(h);
		const request = githubDelivery(
			workflowPayload({ name: "payload-marker-7c1" }),
		);
		const signature = request.headers.get("x-hub-signature-256") ?? "";
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
			result = await acceptIncident(deps, request);
		} finally {
			methods.forEach((method, index) => {
				console[method] = original[index];
			});
		}
		if (result === undefined) throw new Error("Expected a result");
		const serialized = JSON.stringify(result);
		for (const secret of [GITHUB_SECRET, signature, "payload-marker-7c1"])
			expect(serialized).not.toContain(secret);
		const logged = messages.join("\n");
		for (const secret of [GITHUB_SECRET, signature, "payload-marker-7c1"])
			expect(logged).not.toContain(secret);
		expect(messages).toHaveLength(0);
	});
});
