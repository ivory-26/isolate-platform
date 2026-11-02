import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type {
	CountActiveIncidentTasksInput,
	IncidentRepository,
	IncidentSignalInput,
} from "@isolate/db";
import { localDemo } from "./caller-scope.server";
import {
	createInMemoryEventDeliveryLedger,
	type EventDeliveryLedger,
} from "./incident-delivery.server";
import {
	acceptIncident,
	createInMemoryIncidentDedupeStore,
	INCIDENT_DEDUPE_WINDOW_MS,
	type IncidentIntakeDependencies,
	type IncidentRepositoryRoute,
} from "./incident-intake.server";
import {
	DEFAULT_SUBSCRIPTION_AUTONOMY,
	DEFAULT_SUBSCRIPTION_ENVIRONMENTS,
	DEFAULT_SUBSCRIPTION_MIN_SEVERITY,
	type IntegrationSubscriptionRecord,
	matchSubscription,
	resolveSubscriptionMatch,
	type SubscriptionEventDescriptor,
	type SubscriptionRegistry,
} from "./incident-subscription.server";
import { harness, otherScope, scope, workflowPin } from "./test-fixtures";
import {
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_TIMESTAMP_HEADER,
} from "./webhook-signature.server";

/**
 * Wave 23 event pipeline tests: subscription matching, delivery idempotency,
 * lifecycle updates, autonomy levels (A0/A1 unsupported/A2/A3) and tenant
 * boundaries. No provider is contacted; every secret is fabricated.
 */

const NOW = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const NOW_ISO = new Date(NOW).toISOString();
const GENERIC_SECRET = "fabricated-generic-secret-0123456789abcdef";
const GITHUB_SECRET = "fabricated-github-webhook-secret-0123456789";
const PAGERDUTY_SECRET = "fabricated-pagerduty-secret-0123456789abcdef";
const HEAD_SHA = "a".repeat(40);

const route: IncidentRepositoryRoute = {
	organizationId: scope.organizationId,
	repositoryId: localDemo.repositoryId,
	branch: "isolate/incident",
	workflowDefinitionId: workflowPin.workflowDefinitionId,
	workflowVersion: workflowPin.workflowVersion,
	fileOwnership: [],
};

function subscription(
	overrides: Partial<IntegrationSubscriptionRecord> = {},
): IntegrationSubscriptionRecord {
	return {
		id: "sub-1",
		organizationId: scope.organizationId,
		connectorId: "sentry",
		displayName: "Production incidents",
		eventKinds: [],
		environmentAllowlist: [...DEFAULT_SUBSCRIPTION_ENVIRONMENTS],
		minSeverity: DEFAULT_SUBSCRIPTION_MIN_SEVERITY,
		repositoryId: null,
		baseBranch: null,
		autonomyLevel: DEFAULT_SUBSCRIPTION_AUTONOMY,
		enabled: true,
		...overrides,
	};
}

function eventDescriptor(
	overrides: Partial<SubscriptionEventDescriptor> = {},
): SubscriptionEventDescriptor {
	return {
		connectorId: "sentry",
		eventKind: "issue_created",
		severity: "critical",
		environment: "production",
		production: true,
		branch: null,
		baseBranch: null,
		lifecycle: "open",
		...overrides,
	};
}

function registry(
	subscriptions: IntegrationSubscriptionRecord[],
	calls: Array<{ organizationId: string; connectorId: string }> = [],
): SubscriptionRegistry {
	return {
		async listEnabled(input) {
			calls.push(input);
			return subscriptions.filter(
				(candidate) =>
					candidate.organizationId === input.organizationId &&
					candidate.connectorId === input.connectorId,
			);
		},
	};
}

/** Fake signal store: 30-minute bucketed dedupe plus the per-org cap. */
function fakeIncidentRepository(
	options: { active?: number; fail?: boolean } = {},
) {
	const signals: IncidentSignalInput[] = [];
	const recorded = new Map<string, string>();
	const repository: IncidentRepository = {
		async recordIfNew(input) {
			signals.push(input);
			if (options.fail === true) throw new Error("private signal store detail");
			const bucket = Math.floor(
				(input.receivedAt ?? new Date(NOW)).getTime() /
					INCIDENT_DEDUPE_WINDOW_MS,
			);
			const key = `${input.organizationId}:${input.source}:${input.fingerprint}:${bucket}`;
			const existing = recorded.get(key);
			if (existing !== undefined)
				return { ok: true, signalId: existing, created: false };
			const signalId = crypto.randomUUID();
			recorded.set(key, signalId);
			return { ok: true, signalId, created: true };
		},
		async getLatestSignal() {
			return null;
		},
		async reserveIfNewUnderCap(input) {
			if ((options.active ?? 0) >= input.maxActive) {
				return { ok: true, signalId: null, created: false, capped: true };
			}
			const recordedRow = await repository.recordIfNew(input);
			return { ...recordedRow, capped: false };
		},
		async countActiveIncidentTasks(input: CountActiveIncidentTasksInput) {
			void input;
			return options.active ?? 0;
		},
	};
	return { repository, signals };
}

type AutonomyCall = {
	organizationId: string;
	taskId: string;
	autonomyLevel: string;
};

function managedDependencies(
	h: ReturnType<typeof harness>,
	options: {
		subscriptions?: IntegrationSubscriptionRecord[];
		ledger?: EventDeliveryLedger;
		repository?: ReturnType<typeof fakeIncidentRepository>;
		overrides?: Partial<IncidentIntakeDependencies>;
	} = {},
): {
	deps: IncidentIntakeDependencies;
	ledger: ReturnType<typeof createInMemoryEventDeliveryLedger>;
	store: ReturnType<typeof fakeIncidentRepository>;
	autonomy: AutonomyCall[];
	registryCalls: Array<{ organizationId: string; connectorId: string }>;
} {
	const ledger =
		options.ledger === undefined
			? createInMemoryEventDeliveryLedger()
			: (options.ledger as ReturnType<
					typeof createInMemoryEventDeliveryLedger
				>);
	const store = options.repository ?? fakeIncidentRepository();
	const autonomy: AutonomyCall[] = [];
	const registryCalls: Array<{ organizationId: string; connectorId: string }> =
		[];
	const deps: IncidentIntakeDependencies = {
		signingSecret: GENERIC_SECRET,
		githubSecret: GITHUB_SECRET,
		pagerdutySecret: PAGERDUTY_SECRET,
		binding: {
			organizationId: scope.organizationId,
			userId: scope.userId,
			role: "member",
		},
		resolveRepository: async () => route,
		incidentRepository: store.repository,
		subscriptions: registry(options.subscriptions ?? [], registryCalls),
		deliveries: ledger,
		recordTaskAutonomy: async (input) => {
			autonomy.push(input);
		},
		dedupe: createInMemoryIncidentDedupeStore(),
		submitTask: (input) => h.service.submit(input),
		now: () => new Date(NOW),
		...options.overrides,
	};
	return { deps, ledger, store, autonomy, registryCalls };
}

function signalPayload(overrides: Record<string, unknown> = {}) {
	return {
		source: "sentry",
		kind: "issue_created",
		severity: "critical",
		service: "checkout-api",
		fingerprint: "sentry:acme:42:4501",
		title: "TypeError: cannot read properties of undefined",
		summary: "Checkout crashes for 5% of requests.",
		links: [
			{
				label: "Sentry issue",
				url: "https://sentry.io/organizations/acme/issues/4501/",
			},
		],
		receivedAt: NOW_ISO,
		...overrides,
	};
}

function genericDelivery(
	payload: unknown,
	options: { secret?: string; timestamp?: number } = {},
): { rawBody: string; headers: Headers } {
	const rawBody = JSON.stringify(payload);
	const timestamp = String(options.timestamp ?? NOW_SECONDS);
	const signature = createHmac("sha256", options.secret ?? GENERIC_SECRET)
		.update(`${timestamp}.`)
		.update(rawBody)
		.digest("hex");
	const headers = new Headers();
	headers.set(WEBHOOK_TIMESTAMP_HEADER, timestamp);
	headers.set(WEBHOOK_SIGNATURE_HEADER, `sha256=${signature}`);
	return { rawBody, headers };
}

function workflowPayload(
	options: { defaultBranch?: string; headBranch?: string } = {},
) {
	return {
		action: "completed",
		repository: {
			name: "checkout-api",
			full_name: "owner/checkout-api",
			default_branch: options.defaultBranch ?? "main",
			html_url: "https://github.com/owner/checkout-api",
		},
		workflow_run: {
			id: 42,
			name: "CI",
			head_branch: options.headBranch ?? "main",
			head_sha: HEAD_SHA,
			conclusion: "failure",
			html_url: "https://github.com/owner/checkout-api/actions/runs/42",
		},
	};
}

function githubDelivery(
	payload: unknown,
	options: { delivery?: string; secret?: string } = {},
): { rawBody: string; headers: Headers } {
	const rawBody = JSON.stringify(payload);
	const signature = createHmac("sha256", options.secret ?? GITHUB_SECRET)
		.update(rawBody)
		.digest("hex");
	const headers = new Headers();
	headers.set("x-github-event", "workflow_run");
	headers.set("x-github-delivery", options.delivery ?? "delivery-1");
	headers.set("x-hub-signature-256", `sha256=${signature}`);
	return { rawBody, headers };
}

function pagerDutyPayload(
	options: { eventType?: string; eventId?: string } = {},
) {
	const eventType = options.eventType ?? "incident.triggered";
	return {
		event: {
			id: options.eventId ?? "evt-0001",
			event_type: eventType,
			resource_type: "incident",
			occurred_at: NOW_ISO,
			data: {
				id: "PINC123",
				status: eventType === "incident.resolved" ? "resolved" : "triggered",
				title: "Checkout latency above SLO",
				urgency: "high",
				service: { id: "PSVC123", name: "checkout-api" },
				created_at: NOW_ISO,
				html_url: "https://acme.pagerduty.com/incidents/PINC123",
			},
		},
	};
}

function pagerDutyDelivery(
	payload: unknown,
	options: { webhookId?: string } = {},
): { rawBody: string; headers: Headers } {
	const rawBody = JSON.stringify(payload);
	const signature = createHmac("sha256", PAGERDUTY_SECRET)
		.update(rawBody)
		.digest("hex");
	const headers = new Headers();
	headers.set("x-pagerduty-signature", `v1=${signature}`);
	if (options.webhookId !== undefined)
		headers.set("x-webhook-id", options.webhookId);
	return { rawBody, headers };
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

describe("subscription policy", () => {
	test("matches connector, kind, severity, environment and base branch", () => {
		expect(matchSubscription(subscription(), eventDescriptor()).matched).toBe(
			true,
		);
		expect(
			matchSubscription(
				subscription({ eventKinds: ["issue_created"] }),
				eventDescriptor({ eventKind: "issue_unresolved" }),
			),
		).toEqual({ matched: false, reason: "EVENT_KIND_NOT_SUBSCRIBED" });
		expect(
			matchSubscription(
				subscription({ minSeverity: "critical" }),
				eventDescriptor({ severity: "high" }),
			),
		).toEqual({ matched: false, reason: "SEVERITY_BELOW_MINIMUM" });
		expect(
			matchSubscription(
				subscription({ environmentAllowlist: ["staging"] }),
				eventDescriptor({ environment: "production", production: true }),
			),
		).toEqual({ matched: false, reason: "ENVIRONMENT_NOT_ALLOWED" });
		expect(
			matchSubscription(
				subscription(),
				eventDescriptor({ environment: "staging", production: false }),
			),
		).toEqual({ matched: false, reason: "ENVIRONMENT_NOT_ALLOWED" });
		expect(
			matchSubscription(
				subscription({ baseBranch: "main" }),
				eventDescriptor({ branch: "release/1.2" }),
			),
		).toEqual({ matched: false, reason: "BASE_BRANCH_MISMATCH" });
		expect(
			matchSubscription(
				subscription({ baseBranch: "main" }),
				eventDescriptor({ branch: "main" }),
			).matched,
		).toBe(true);
		// Branchless connectors are repository-scoped, not branch-scoped.
		expect(
			matchSubscription(
				subscription({ baseBranch: "main" }),
				eventDescriptor({ branch: null }),
			).matched,
		).toBe(true);
		expect(
			matchSubscription(
				subscription({ connectorId: "github" }),
				eventDescriptor(),
			),
		).toEqual({ matched: false, reason: "CONNECTOR_MISMATCH" });
	});

	test("applies the default safe posture: production, high, A2", () => {
		expect(DEFAULT_SUBSCRIPTION_ENVIRONMENTS).toEqual(["production"]);
		expect(DEFAULT_SUBSCRIPTION_MIN_SEVERITY).toBe("high");
		expect(DEFAULT_SUBSCRIPTION_AUTONOMY).toBe("A2");
		expect(
			matchSubscription(
				subscription(),
				eventDescriptor({ severity: "medium" }),
			),
		).toEqual({ matched: false, reason: "SEVERITY_BELOW_MINIMUM" });
		expect(
			matchSubscription(
				subscription(),
				eventDescriptor({ environment: null, production: true }),
			).matched,
		).toBe(true);
		// GitHub high on the default branch is the deployed line.
		expect(
			matchSubscription(
				subscription({ connectorId: "github" }),
				eventDescriptor({
					connectorId: "github",
					severity: "high",
					environment: "production",
					production: true,
					branch: "main",
					baseBranch: "main",
				}),
			).matched,
		).toBe(true);
	});

	test("a disabled rule never matches and reports why", () => {
		expect(
			matchSubscription(subscription({ enabled: false }), eventDescriptor()),
		).toEqual({ matched: false, reason: "SUBSCRIPTION_DISABLED" });
		expect(
			resolveSubscriptionMatch(
				[subscription({ enabled: false })],
				eventDescriptor(),
			),
		).toEqual({ matched: false, reason: "SUBSCRIPTION_DISABLED" });
	});

	test("prefers the most specific enabled rule", () => {
		const broad = subscription({ id: "broad", eventKinds: [] });
		const specific = subscription({
			id: "specific",
			eventKinds: ["issue_created"],
		});
		const result = resolveSubscriptionMatch(
			[broad, specific],
			eventDescriptor(),
		);
		expect(result.matched && result.subscription.id).toBe("specific");
	});
});

describe("managed intake", () => {
	test("A2 creates one task and one task_created delivery", async () => {
		const h = harness();
		const { deps, ledger, store, autonomy, registryCalls } =
			managedDependencies(h, { subscriptions: [subscription()] });
		const result = createdTask(
			await acceptIncident(deps, genericDelivery(signalPayload())),
		);
		expect(h.tasks.calls).toHaveLength(1);
		expect(registryCalls).toEqual([
			{ organizationId: scope.organizationId, connectorId: "sentry" },
		]);
		const rows = ledger.rows();
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (row === undefined) throw new Error("Expected a delivery row");
		expect(row.connectorId).toBe("sentry");
		expect(row.subscriptionId).toBe("sub-1");
		expect(row.status).toBe("task_created");
		expect(row.reasonCode).toBeNull();
		expect(row.taskId).toBe(result.taskId);
		expect(row.signalId).not.toBeNull();
		expect(row.bodySha256).toMatch(/^[0-9a-f]{64}$/);
		expect(row.processedAt).not.toBeNull();
		expect(store.signals).toHaveLength(1);
		expect(autonomy).toEqual([
			{
				organizationId: scope.organizationId,
				taskId: result.taskId,
				autonomyLevel: "A2",
			},
		]);
		// Bounded display fields reach the signal, never the raw payload.
		const display = ledger.signalDisplays()[0];
		expect(display?.title).toBe(
			"TypeError: cannot read properties of undefined",
		);
		expect(display?.summary).toContain("Checkout crashes");
		expect(display?.links).toHaveLength(1);
		// Only the bounded display fields are persisted, never a raw payload.
		expect(Object.keys(display ?? {}).sort()).toEqual([
			"links",
			"organizationId",
			"signalId",
			"summary",
			"title",
		]);
	});

	test("A0 records the event and creates no task", async () => {
		const h = harness();
		const { deps, ledger } = managedDependencies(h, {
			subscriptions: [subscription({ autonomyLevel: "A0" })],
		});
		expect(
			await acceptIncident(deps, genericDelivery(signalPayload())),
		).toEqual({
			ok: true,
			accepted: false,
			deduped: false,
			throttled: false,
			ignored: true,
		});
		expect(h.tasks.calls).toHaveLength(0);
		expect(h.queue.calls).toHaveLength(0);
		const row = ledger.rows()[0];
		expect(row?.status).toBe("ignored");
		expect(row?.reasonCode).toBe("AUTONOMY_OBSERVE_ONLY");
		expect(row?.signalId).not.toBeNull();
	});

	test("A1 is recorded as ignored with AUTONOMY_LEVEL_UNSUPPORTED", async () => {
		const h = harness();
		const { deps, ledger } = managedDependencies(h, {
			subscriptions: [subscription({ autonomyLevel: "A1" })],
		});
		await acceptIncident(deps, genericDelivery(signalPayload()));
		expect(h.tasks.calls).toHaveLength(0);
		const row = ledger.rows()[0];
		expect(row?.status).toBe("ignored");
		expect(row?.reasonCode).toBe("AUTONOMY_LEVEL_UNSUPPORTED");
	});

	test("A3 keeps the A2 task payload and the existing approval gates", async () => {
		const a2 = harness();
		const a2Deps = managedDependencies(a2, {
			subscriptions: [subscription({ autonomyLevel: "A2" })],
		});
		await acceptIncident(a2Deps.deps, genericDelivery(signalPayload()));

		const a3 = harness();
		const a3Deps = managedDependencies(a3, {
			subscriptions: [subscription({ autonomyLevel: "A3" })],
		});
		await acceptIncident(a3Deps.deps, genericDelivery(signalPayload()));

		expect(a3.tasks.calls).toHaveLength(1);
		// Identical submission boundary: A3 adds no gate and removes none.
		expect(a3.tasks.calls[0]).toEqual(a2.tasks.calls[0]);
		expect(a3.queue.calls).toHaveLength(1);
		expect(a3Deps.autonomy[0]?.autonomyLevel).toBe("A3");
	});

	test("a non-matching rule records an ignored delivery and no task", async () => {
		const h = harness();
		const { deps, ledger } = managedDependencies(h, {
			subscriptions: [subscription({ minSeverity: "critical" })],
		});
		const result = await acceptIncident(
			deps,
			genericDelivery(signalPayload({ severity: "high" })),
		);
		expect(result.ok).toBe(true);
		expect(h.tasks.calls).toHaveLength(0);
		expect(ledger.rows()[0]?.status).toBe("ignored");
		expect(ledger.rows()[0]?.reasonCode).toBe("SEVERITY_BELOW_MINIMUM");
	});

	test("dedupes by provider delivery id and creates no second task", async () => {
		const h = harness();
		const { deps, ledger } = managedDependencies(h, {
			subscriptions: [subscription({ connectorId: "github" })],
		});
		const first = createdTask(
			await acceptIncident(deps, githubDelivery(workflowPayload())),
		);
		const replay = await acceptIncident(
			deps,
			githubDelivery(workflowPayload()),
		);
		expect(replay).toEqual({
			ok: true,
			accepted: false,
			deduped: true,
			throttled: false,
		});
		expect(h.tasks.calls).toHaveLength(1);
		const rows = ledger.rows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("deduplicated");
		expect(rows[0]?.reasonCode).toBe("DUPLICATE_DELIVERY");
		expect(rows[0]?.taskId).toBe(first.taskId);
	});

	test("concurrent deliveries of one fingerprint create one task", async () => {
		const h = harness();
		const { deps } = managedDependencies(h, {
			subscriptions: [subscription()],
		});
		const results = await Promise.all([
			acceptIncident(deps, genericDelivery(signalPayload())),
			acceptIncident(deps, genericDelivery(signalPayload())),
		]);
		expect(h.tasks.calls).toHaveLength(1);
		const created = results.filter((result) => result.ok && "taskId" in result);
		expect(created.length).toBeGreaterThanOrEqual(1);
	});

	test("a resolved lifecycle event updates the task and creates none", async () => {
		const h = harness();
		const { deps, ledger } = managedDependencies(h, {
			subscriptions: [subscription({ connectorId: "pagerduty" })],
		});
		const triggered = createdTask(
			await acceptIncident(
				deps,
				pagerDutyDelivery(pagerDutyPayload(), { webhookId: "evt-1" }),
			),
		);
		const resolved = await acceptIncident(
			deps,
			pagerDutyDelivery(
				pagerDutyPayload({ eventType: "incident.resolved", eventId: "evt-2" }),
				{ webhookId: "evt-2" },
			),
		);
		expect(resolved).toEqual({
			ok: true,
			accepted: false,
			deduped: false,
			throttled: false,
			ignored: true,
		});
		expect(h.tasks.calls).toHaveLength(1);
		const rows = ledger.rows();
		expect(rows).toHaveLength(2);
		expect(rows[1]?.status).toBe("task_updated");
		expect(rows[1]?.reasonCode).toBe("LIFECYCLE_UPDATE");
		expect(rows[1]?.taskId).toBe(triggered.taskId);
	});

	test("cross-tenant and unmapped repository ids are rejected", async () => {
		const foreignOrg = harness();
		const foreign = managedDependencies(foreignOrg, {
			subscriptions: [subscription()],
			overrides: {
				resolveRepository: async () => ({
					...route,
					organizationId: otherScope.organizationId,
				}),
			},
		});
		expect(
			await acceptIncident(foreign.deps, genericDelivery(signalPayload())),
		).toEqual({ ok: false, code: "FORBIDDEN" });
		expect(foreignOrg.tasks.calls).toHaveLength(0);
		expect(foreign.ledger.rows()[0]?.status).toBe("rejected");
		expect(foreign.ledger.rows()[0]?.reasonCode).toBe("TENANT_MISMATCH");

		const missingRepo = harness();
		const unmapped = managedDependencies(missingRepo, {
			subscriptions: [
				subscription({ repositoryId: "99999999-9999-4999-8999-999999999999" }),
			],
			overrides: {
				resolveRepository: async (input) =>
					input.repositoryId === undefined ? route : null,
			},
		});
		expect(
			await acceptIncident(unmapped.deps, genericDelivery(signalPayload())),
		).toEqual({ ok: false, code: "NOT_FOUND" });
		expect(missingRepo.tasks.calls).toHaveLength(0);
		expect(unmapped.ledger.rows()[0]?.reasonCode).toBe("REPOSITORY_UNMAPPED");
	});

	test("a foreign subscription row never drives this tenant's task", async () => {
		const h = harness();
		const foreignSubscription = subscription({
			id: "foreign-sub",
			organizationId: otherScope.organizationId,
			repositoryId: "99999999-9999-4999-8999-999999999999",
		});
		const requested: Array<string | undefined> = [];
		const { deps } = managedDependencies(h, {
			subscriptions: [],
			overrides: {
				subscriptions: {
					async listEnabled() {
						// A leaky reader: it ignores its own tenant filter.
						return [foreignSubscription];
					},
				},
				resolveRepository: async (input) => {
					requested.push(input.repositoryId);
					return route;
				},
			},
		});
		createdTask(await acceptIncident(deps, genericDelivery(signalPayload())));
		expect(requested).toEqual([undefined]);
		expect(h.tasks.calls[0]?.repositoryId).toBe(route.repositoryId);
	});

	test("legacy fallback still applies when no subscription exists", async () => {
		const h = harness();
		const { deps, ledger } = managedDependencies(h, { subscriptions: [] });
		const result = createdTask(
			await acceptIncident(deps, genericDelivery(signalPayload())),
		);
		expect(h.tasks.calls).toHaveLength(1);
		expect(ledger.rows()[0]?.status).toBe("task_created");
		expect(ledger.rows()[0]?.subscriptionId).toBeNull();
		expect(result.deduped).toBe(false);

		const replay = await acceptIncident(
			deps,
			genericDelivery(signalPayload(), { timestamp: NOW_SECONDS + 60 }),
		);
		expect(replay).toEqual({
			ok: true,
			taskId: result.taskId,
			jobId: result.jobId,
			deduped: true,
		});
		expect(h.tasks.calls).toHaveLength(1);
	});

	test("rejected signatures are recorded without creating a task", async () => {
		const h = harness();
		const { deps, ledger } = managedDependencies(h, {
			subscriptions: [subscription()],
		});
		const delivery = genericDelivery(signalPayload(), {
			secret: "another-fabricated-secret-0123456789abcdef",
		});
		expect(await acceptIncident(deps, delivery)).toEqual({
			ok: false,
			code: "UNAUTHORIZED",
		});
		expect(h.tasks.calls).toHaveLength(0);
		const row = ledger.rows()[0];
		expect(row?.status).toBe("rejected");
		expect(row?.reasonCode).toBe("SIGNATURE_REJECTED");
	});
});
