import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type {
	CountActiveIncidentTasksInput,
	IncidentRepository,
	IncidentSignalInput,
} from "@isolate/db";
import { localDemo } from "./caller-scope.server";
import {
	acceptIncident,
	createInMemoryIncidentDedupeStore,
	detectIncidentIntakeMode,
	INCIDENT_DEDUPE_WINDOW_MS,
	type IncidentIntakeDependencies,
	type IncidentRepositoryRoute,
	UNTRUSTED_INCIDENT_NOTICE,
} from "./incident-intake.server";
import { GRAFANA_DEFAULT_TIMESTAMP_HEADER } from "./incident-intake-grafana.server";
import { harness, scope, workflowPin } from "./test-fixtures";

/**
 * First-batch adapter intake (wave 17): Sentry, Grafana and PagerDuty bound to
 * the existing signed receiver. Every credential here is fabricated; no test
 * reads an environment file, opens a database or calls a provider.
 */

const NOW = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const NOW_ISO = new Date(NOW).toISOString();

const GENERIC_SECRET = "fabricated-generic-secret-0123456789abcdef";
const SENTRY_SECRET = "fabricated-sentry-secret-0123456789";
const GRAFANA_SECRET = "fabricated-grafana-secret-0123456789abcdef";
const PAGERDUTY_SECRET = "fabricated-pagerduty-secret-0123456789abcdef";

const route: IncidentRepositoryRoute = {
	organizationId: scope.organizationId,
	repositoryId: localDemo.repositoryId,
	branch: "isolate/incident",
	workflowDefinitionId: workflowPin.workflowDefinitionId,
	workflowVersion: workflowPin.workflowVersion,
	fileOwnership: [],
};

/** Fake signal store: shares the dedupe bucket and records every call. */
function incidentStore(
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

function dependencies(
	h: ReturnType<typeof harness>,
	overrides: Partial<IncidentIntakeDependencies> = {},
): IncidentIntakeDependencies {
	return {
		// Generic stays configured so a missing adapter secret proves there is no
		// fallback to another verifier.
		signingSecret: GENERIC_SECRET,
		sentrySecret: SENTRY_SECRET,
		grafanaSecret: GRAFANA_SECRET,
		pagerdutySecret: PAGERDUTY_SECRET,
		grafanaAllowUnsigned: false,
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

function createdTask(result: Awaited<ReturnType<typeof acceptIncident>>): {
	taskId: string;
	jobId: string;
	deduped: boolean;
} {
	if (!result.ok || !("taskId" in result))
		throw new Error("Expected a created task");
	return result;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

type DeliveryOptions = {
	secret?: string | null;
	timestamp?: number;
	signature?: string | null;
	body?: string;
	resource?: string | null;
};

function sentryDelivery(
	payload: unknown,
	options: DeliveryOptions = {},
): { rawBody: string; headers: Headers } {
	const rawBody = options.body ?? JSON.stringify(payload);
	const signature =
		options.signature === undefined
			? createHmac("sha256", options.secret ?? SENTRY_SECRET)
					.update(rawBody)
					.digest("hex")
			: options.signature;
	const headers = new Headers();
	const resource = options.resource === undefined ? "issue" : options.resource;
	if (resource !== null) headers.set("sentry-hook-resource", resource);
	headers.set(
		"sentry-hook-timestamp",
		String(options.timestamp ?? NOW_SECONDS),
	);
	if (signature !== null) headers.set("sentry-hook-signature", signature);
	return { rawBody, headers };
}

function grafanaDelivery(
	payload: unknown,
	options: DeliveryOptions = {},
): { rawBody: string; headers: Headers } {
	const rawBody = options.body ?? JSON.stringify(payload);
	const timestamp = String(options.timestamp ?? NOW_SECONDS);
	const secret = options.secret === undefined ? GRAFANA_SECRET : options.secret;
	const signature =
		options.signature === undefined
			? secret === null
				? null
				: createHmac("sha256", secret)
						.update(`${timestamp}:`)
						.update(rawBody)
						.digest("hex")
			: options.signature;
	const headers = new Headers();
	headers.set(GRAFANA_DEFAULT_TIMESTAMP_HEADER, timestamp);
	if (signature !== null)
		headers.set("x-grafana-alerting-signature", signature);
	return { rawBody, headers };
}

function pagerDutyDelivery(
	payload: unknown,
	options: DeliveryOptions = {},
): { rawBody: string; headers: Headers } {
	const rawBody = options.body ?? JSON.stringify(payload);
	const signature =
		options.signature === undefined
			? `v1=${createHmac("sha256", options.secret ?? PAGERDUTY_SECRET)
					.update(rawBody)
					.digest("hex")}`
			: options.signature;
	const headers = new Headers();
	if (signature !== null) headers.set("x-pagerduty-signature", signature);
	return { rawBody, headers };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

function sentryPayload(
	options: { action?: string; level?: string; title?: string } = {},
) {
	return {
		action: options.action ?? "created",
		issue: {
			id: "4501",
			shortId: "CHECKOUT-1",
			title: options.title ?? "TypeError: cannot read properties of undefined",
			level: options.level ?? "error",
			status: "unresolved",
			permalink: "https://sentry.io/organizations/acme/issues/4501/",
		},
		organization: { slug: "acme" },
		project: { id: "42", slug: "checkout-api" },
	};
}

function grafanaPayload(
	options: {
		status?: string;
		alertStatus?: string;
		environment?: string;
		severity?: string;
	} = {},
) {
	return {
		version: "1",
		status: options.status ?? "firing",
		alerts: [
			{
				status: options.alertStatus ?? "firing",
				labels: {
					alertname: "HighErrorRate",
					service: "checkout-api",
					environment: options.environment ?? "production",
					severity: options.severity ?? "critical",
					__rule_uid__: "rule-1",
				},
				annotations: { summary: "5xx rate above 5%" },
				startsAt: "2026-11-01T10:00:00Z",
				generatorURL:
					"https://grafana.example.com/alerting/grafana/rule-1/view",
			},
		],
	};
}

function pagerDutyPayload(
	options: { eventType?: string; eventId?: string; occurredAt?: string } = {},
) {
	const eventType = options.eventType ?? "incident.triggered";
	const occurredAt = options.occurredAt ?? NOW_ISO;
	return {
		event: {
			id: options.eventId ?? "evt-0001",
			event_type: eventType,
			resource_type: "incident",
			occurred_at: occurredAt,
			data: {
				id: "PINC123",
				status: eventType === "incident.resolved" ? "resolved" : "triggered",
				title: "Checkout latency above SLO",
				urgency: "high",
				service: { id: "PSVC123", name: "checkout-api" },
				created_at: occurredAt,
				html_url: "https://acme.pagerduty.com/incidents/PINC123",
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

describe("adapter mode selection", () => {
	test("selects every mode from its own headers only", () => {
		expect(detectIncidentIntakeMode({ "x-github-event": "workflow_run" })).toBe(
			"github",
		);
		expect(
			detectIncidentIntakeMode({ "sentry-hook-signature": "ab".repeat(32) }),
		).toBe("sentry");
		expect(detectIncidentIntakeMode({ "sentry-hook-resource": "issue" })).toBe(
			"sentry",
		);
		expect(
			detectIncidentIntakeMode({ "x-grafana-alerting-signature": "ab" }),
		).toBe("grafana");
		expect(
			detectIncidentIntakeMode({ "x-grafana-alerting-timestamp": "1" }),
		).toBe("grafana");
		expect(detectIncidentIntakeMode({ "x-pagerduty-signature": "v1=ab" })).toBe(
			"pagerduty",
		);
		expect(detectIncidentIntakeMode({})).toBe("generic");
	});

	test("uses the configured Grafana timestamp header, not the default", () => {
		expect(
			detectIncidentIntakeMode(
				{ "x-custom-timestamp": "1" },
				{ grafanaTimestampHeader: "x-custom-timestamp" },
			),
		).toBe("grafana");
		expect(
			detectIncidentIntakeMode(
				{ "x-grafana-alerting-timestamp": "1" },
				{ grafanaTimestampHeader: "x-custom-timestamp" },
			),
		).toBe("generic");
		// A disabled timestamp header can only be selected by the signature.
		expect(
			detectIncidentIntakeMode(
				{ "x-grafana-alerting-timestamp": "1" },
				{ grafanaTimestampHeader: null },
			),
		).toBe("generic");
	});

	test("fails deterministically when two provider headers arrive", () => {
		expect(
			detectIncidentIntakeMode({
				"x-github-event": "push",
				"sentry-hook-resource": "issue",
				"x-grafana-alerting-signature": "ab",
				"x-pagerduty-signature": "v1=ab",
			}),
		).toBe("github");
		expect(
			detectIncidentIntakeMode({
				"sentry-hook-resource": "issue",
				"x-grafana-alerting-signature": "ab",
				"x-pagerduty-signature": "v1=ab",
			}),
		).toBe("sentry");
		expect(
			detectIncidentIntakeMode({
				"x-grafana-alerting-signature": "ab",
				"x-pagerduty-signature": "v1=ab",
			}),
		).toBe("grafana");
	});

	test("blank provider headers never select a mode", () => {
		expect(detectIncidentIntakeMode({ "sentry-hook-signature": "  " })).toBe(
			"generic",
		);
		expect(detectIncidentIntakeMode({ "x-pagerduty-signature": " " })).toBe(
			"generic",
		);
	});
});

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

describe("sentry delivery", () => {
	test("creates one task with signal provenance and an untrusted goal", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		const result = createdTask(
			await acceptIncident(deps, sentryDelivery(sentryPayload())),
		);
		expect(result.deduped).toBe(false);
		expect(h.tasks.calls).toHaveLength(1);
		const task = h.tasks.calls[0];
		if (task === undefined) throw new Error("Expected a task row");
		expect(task.incidentSource).toBe("sentry");
		expect(task.incidentFingerprint).toBe("sentry:acme:42:4501");
		expect(task.goal?.startsWith(UNTRUSTED_INCIDENT_NOTICE)).toBe(true);
		expect(task.goal).toContain("TypeError");
		expect(store.signalCalls).toHaveLength(1);
		const recorded = store.signalCalls[0];
		if (recorded === undefined) throw new Error("Expected a signal row");
		expect(recorded.source).toBe("sentry");
		expect(recorded.severity).toBe("high");
		expect(recorded.service).toBe("checkout-api");
	});

	test("ignores a resolved lifecycle event without writing anything", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		expect(
			await acceptIncident(
				deps,
				sentryDelivery(sentryPayload({ action: "resolved" })),
			),
		).toEqual({
			ok: true,
			accepted: false,
			deduped: false,
			throttled: false,
			ignored: true,
		});
		expect(store.signalCalls).toHaveLength(0);
		expect(store.capCalls).toHaveLength(0);
		expect(h.tasks.calls).toHaveLength(0);
		expect(h.queue.calls).toHaveLength(0);
	});

	test("rejects bad signatures, stale timestamps and unsupported resources", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		const cases = [
			sentryDelivery(sentryPayload(), { secret: GENERIC_SECRET }),
			sentryDelivery(sentryPayload(), { timestamp: NOW_SECONDS - 301 }),
			sentryDelivery(sentryPayload(), { signature: "ab".repeat(32) }),
			sentryDelivery(sentryPayload(), { signature: null }),
			sentryDelivery(sentryPayload(), { resource: "event_alert" }),
		];
		for (const request of cases)
			expect(await acceptIncident(deps, request)).toEqual({
				ok: false,
				code: "UNAUTHORIZED",
			});
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("missing secret is 503 and never falls back to generic", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, {
			incidentRepository: store.repository,
			sentrySecret: null,
		});
		expect(await acceptIncident(deps, sentryDelivery(sentryPayload()))).toEqual(
			{
				ok: false,
				code: "UNAVAILABLE",
			},
		);
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("malformed JSON after a valid signature is a 400", async () => {
		const h = harness();
		const deps = dependencies(h, {
			incidentRepository: incidentStore().repository,
		});
		expect(
			await acceptIncident(deps, sentryDelivery(null, { body: "{not json" })),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("dedupes by fingerprint, not by delivery metadata", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		const first = createdTask(
			await acceptIncident(deps, sentryDelivery(sentryPayload())),
		);
		const replay = createdTask(
			await acceptIncident(deps, {
				...sentryDelivery(sentryPayload({ level: "fatal" }), {
					timestamp: NOW_SECONDS + 60,
				}),
				now: NOW + 60_000,
			}),
		);
		expect(replay).toEqual({ ...first, deduped: true });
		expect(h.tasks.calls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Grafana
// ---------------------------------------------------------------------------

describe("grafana delivery", () => {
	test("creates one task from a signed production firing alert", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		const result = createdTask(
			await acceptIncident(deps, grafanaDelivery(grafanaPayload())),
		);
		expect(result.deduped).toBe(false);
		const task = h.tasks.calls[0];
		if (task === undefined) throw new Error("Expected a task row");
		expect(task.incidentSource).toBe("grafana");
		expect(task.incidentFingerprint?.startsWith("grafana:rule-1:")).toBe(true);
		expect(task.goal).toContain("HighErrorRate");
		expect(store.signalCalls[0]?.source).toBe("grafana");
	});

	test("ignores resolved and non-production groups", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		for (const payload of [
			grafanaPayload({ status: "resolved", alertStatus: "resolved" }),
			grafanaPayload({ environment: "staging" }),
			grafanaPayload({ status: "firing", alertStatus: "resolved" }),
		]) {
			expect(await acceptIncident(deps, grafanaDelivery(payload))).toEqual({
				ok: true,
				accepted: false,
				deduped: false,
				throttled: false,
				ignored: true,
			});
		}
		expect(store.signalCalls).toHaveLength(0);
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("unsigned Grafana requires the explicit opt-in", async () => {
		const blocked = harness();
		const blockedDeps = dependencies(blocked, {
			incidentRepository: incidentStore().repository,
			grafanaSecret: null,
			grafanaAllowUnsigned: false,
		});
		expect(
			await acceptIncident(
				blockedDeps,
				grafanaDelivery(grafanaPayload(), { secret: null }),
			),
		).toEqual({ ok: false, code: "UNAVAILABLE" });

		const allowed = harness();
		const allowedDeps = dependencies(allowed, {
			incidentRepository: incidentStore().repository,
			grafanaSecret: null,
			grafanaAllowUnsigned: true,
		});
		createdTask(
			await acceptIncident(
				allowedDeps,
				grafanaDelivery(grafanaPayload(), { secret: null }),
			),
		);
		expect(allowed.tasks.calls).toHaveLength(1);
	});

	test("unsigned still enforces the 64 KiB cap", async () => {
		const h = harness();
		const deps = dependencies(h, {
			incidentRepository: incidentStore().repository,
			grafanaSecret: null,
			grafanaAllowUnsigned: true,
		});
		const oversized = grafanaPayload();
		const request = grafanaDelivery(oversized, {
			secret: null,
			body: JSON.stringify({
				...oversized,
				message: "x".repeat(64 * 1024),
			}),
		});
		expect(await acceptIncident(deps, request)).toEqual({
			ok: false,
			code: "PAYLOAD_TOO_LARGE",
		});
	});

	test("a claimed but unverifiable signature is rejected", async () => {
		const h = harness();
		const deps = dependencies(h, {
			incidentRepository: incidentStore().repository,
			grafanaSecret: null,
			grafanaAllowUnsigned: true,
		});
		expect(
			await acceptIncident(
				deps,
				grafanaDelivery(grafanaPayload(), { secret: null, signature: "ab" }),
			),
		).toEqual({ ok: false, code: "UNAUTHORIZED" });
	});

	test("rejects a bad signature and a missing timestamp header", async () => {
		const h = harness();
		const deps = dependencies(h, {
			incidentRepository: incidentStore().repository,
		});
		expect(
			await acceptIncident(
				deps,
				grafanaDelivery(grafanaPayload(), { secret: PAGERDUTY_SECRET }),
			),
		).toEqual({ ok: false, code: "UNAUTHORIZED" });
		const request = grafanaDelivery(grafanaPayload());
		request.headers.delete(GRAFANA_DEFAULT_TIMESTAMP_HEADER);
		expect(await acceptIncident(deps, request)).toEqual({
			ok: false,
			code: "UNAUTHORIZED",
		});
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("dedupes label churn on the same rule, service and environment", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		const first = createdTask(
			await acceptIncident(deps, grafanaDelivery(grafanaPayload())),
		);
		const secondPayload = grafanaPayload();
		const alert = secondPayload.alerts[0];
		if (alert === undefined) throw new Error("Expected an alert");
		alert.annotations = { summary: "different annotation text" };
		const replay = createdTask(
			await acceptIncident(
				deps,
				grafanaDelivery(secondPayload, { timestamp: NOW_SECONDS + 60 }),
			),
		);
		expect(replay).toEqual({ ...first, deduped: true });
		expect(h.tasks.calls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// PagerDuty
// ---------------------------------------------------------------------------

describe("pagerduty delivery", () => {
	test("creates one task from a triggered incident", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		createdTask(
			await acceptIncident(deps, pagerDutyDelivery(pagerDutyPayload())),
		);
		const task = h.tasks.calls[0];
		if (task === undefined) throw new Error("Expected a task row");
		expect(task.incidentSource).toBe("pagerduty");
		expect(task.incidentFingerprint).toBe("pagerduty:PSVC123:PINC123");
		expect(task.goal).toContain("Checkout latency above SLO");
		expect(store.signalCalls[0]?.severity).toBe("critical");
	});

	test("ignores resolved lifecycle events", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		expect(
			await acceptIncident(
				deps,
				pagerDutyDelivery(pagerDutyPayload({ eventType: "incident.resolved" })),
			),
		).toEqual({
			ok: true,
			accepted: false,
			deduped: false,
			throttled: false,
			ignored: true,
		});
		expect(store.signalCalls).toHaveLength(0);
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("rejects a stale occurred_at and a bad signature", async () => {
		const h = harness();
		const deps = dependencies(h, {
			incidentRepository: incidentStore().repository,
		});
		expect(
			await acceptIncident(
				deps,
				pagerDutyDelivery(
					pagerDutyPayload({
						occurredAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
					}),
				),
			),
		).toEqual({ ok: false, code: "UNAUTHORIZED" });
		expect(
			await acceptIncident(
				deps,
				pagerDutyDelivery(pagerDutyPayload(), { secret: SENTRY_SECRET }),
			),
		).toEqual({ ok: false, code: "UNAUTHORIZED" });
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("missing secret is 503 and never falls back to generic", async () => {
		const h = harness();
		const deps = dependencies(h, {
			incidentRepository: incidentStore().repository,
			pagerdutySecret: null,
		});
		expect(
			await acceptIncident(deps, pagerDutyDelivery(pagerDutyPayload())),
		).toEqual({ ok: false, code: "UNAVAILABLE" });
	});

	test("dedupes by incident fingerprint, not the webhook event id", async () => {
		const h = harness();
		const store = incidentStore();
		const deps = dependencies(h, { incidentRepository: store.repository });
		const first = createdTask(
			await acceptIncident(
				deps,
				pagerDutyDelivery(pagerDutyPayload({ eventId: "evt-0001" })),
			),
		);
		const replay = createdTask(
			await acceptIncident(
				deps,
				pagerDutyDelivery(pagerDutyPayload({ eventId: "evt-0002" })),
			),
		);
		expect(replay).toEqual({ ...first, deduped: true });
		expect(h.tasks.calls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Cross-mode isolation and hygiene
// ---------------------------------------------------------------------------

describe("cross-mode isolation", () => {
	test("each mode rejects a signature made with another mode's secret", async () => {
		const h = harness();
		const deps = dependencies(h, {
			incidentRepository: incidentStore().repository,
		});
		expect(
			await acceptIncident(
				deps,
				sentryDelivery(sentryPayload(), { secret: GRAFANA_SECRET }),
			),
		).toEqual({ ok: false, code: "UNAUTHORIZED" });
		expect(
			await acceptIncident(
				deps,
				grafanaDelivery(grafanaPayload(), { secret: SENTRY_SECRET }),
			),
		).toEqual({ ok: false, code: "UNAUTHORIZED" });
		expect(
			await acceptIncident(
				deps,
				pagerDutyDelivery(pagerDutyPayload(), { secret: GRAFANA_SECRET }),
			),
		).toEqual({ ok: false, code: "UNAUTHORIZED" });
		expect(h.tasks.calls).toHaveLength(0);
	});

	test("a provider-shaped body cannot opt into adapter mode", async () => {
		const h = harness();
		const deps = dependencies(h, {
			incidentRepository: incidentStore().repository,
		});
		const rawBody = JSON.stringify(sentryPayload());
		const timestamp = String(NOW_SECONDS);
		const signature = `sha256=${createHmac("sha256", GENERIC_SECRET)
			.update(`${timestamp}.`)
			.update(rawBody)
			.digest("hex")}`;
		const headers = new Headers();
		headers.set("x-isolate-timestamp", timestamp);
		headers.set("x-isolate-signature", signature);
		// Generic mode accepts the signature but the body is not an IncidentSignal.
		expect(await acceptIncident(deps, { rawBody, headers })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		expect(h.tasks.calls).toHaveLength(0);
	});
});

describe("adapter hygiene", () => {
	test("never returns a secret, signature or payload marker", async () => {
		const h = harness();
		const deps = dependencies(h, {
			incidentRepository: incidentStore().repository,
		});
		const request = sentryDelivery(
			sentryPayload({ title: "payload-marker-3d9" }),
		);
		const signature = request.headers.get("sentry-hook-signature") ?? "";
		const ok = await acceptIncident(deps, request);
		expect(ok.ok).toBe(true);
		const serialized = JSON.stringify(ok);
		for (const value of [SENTRY_SECRET, signature, "payload-marker-3d9"])
			expect(serialized).not.toContain(value);

		const failing = await acceptIncident(
			dependencies(h, { incidentRepository: incidentStore().repository }),
			sentryDelivery(sentryPayload(), { secret: GENERIC_SECRET }),
		);
		const failed = JSON.stringify(failing);
		expect(failed).not.toContain(GENERIC_SECRET);
		expect(failed).not.toContain(SENTRY_SECRET);
	});
});
