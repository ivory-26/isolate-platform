import { createHash, createHmac } from "node:crypto";
import type { IncidentRepository } from "../packages/db/src/index";
import {
	InMemoryApprovalRepository,
	InMemoryArtifactRepository,
	InMemoryExecutionLifecycle,
	InMemoryQueueRepository,
	InMemoryTaskRepository,
} from "../packages/db/src/testing/index";
import { createInMemoryWorkflowCompilationRepositories } from "../packages/db/src/testing/workflow-compilation";
import {
	fetchAxiomIncidentContext,
	fetchDatadogContext,
	fetchGitHubIncidentContext,
	fetchGrafanaContext,
	fetchHoneycombIncidentContext,
	fetchKubernetesContext,
	fetchNewRelicContext,
	fetchPagerDutyContext,
	fetchSentryContext,
	fetchSignozContext,
	type KubernetesHttpClient,
} from "../packages/integrations/src/index";
import {
	type ContextBundle,
	contextBundleSchema,
	incidentSignalSchema,
	type OrganizationId,
	asTaskId,
	type IncidentSource,
	type TaskId,
} from "../packages/shared/src/index";
import {
	type ConnectorContextDependencies,
	createConnectorContextLoader,
} from "../apps/worker/src/connector-context";
import { localDemo } from "../apps/web/src/server/caller-scope.server";
import { createDevelopmentAuthoredVersions } from "../apps/web/src/server/development-workflows.server";
import { createInMemoryEventDeliveryLedger } from "../apps/web/src/server/incident-delivery.server";
import {
	acceptIncident,
	createInMemoryIncidentDedupeStore,
	type IncidentIntakeDependencies,
	type IncidentRepositoryRoute,
} from "../apps/web/src/server/incident-intake.server";
import {
	DEFAULT_SUBSCRIPTION_ENVIRONMENTS,
	DEFAULT_SUBSCRIPTION_MIN_SEVERITY,
	type IntegrationSubscriptionRecord,
	type SubscriptionRegistry,
} from "../apps/web/src/server/incident-subscription.server";
import { createRepositoryStore } from "../apps/web/src/server/repository-store.server";
import { createSubmissionCompiler } from "../apps/web/src/server/submission-compilation.server";
import { createTaskService } from "../apps/web/src/server/task-service.server";
import {
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_TIMESTAMP_HEADER,
} from "../apps/web/src/server/webhook-signature.server";

/**
 * Offline connector benchmark (project/BENCHMARK-PLAN.md).
 *
 * Drives the same seams the product uses, with zero provider credentials:
 *
 *   signed webhook -> mode detection -> HMAC verification -> normalize ->
 *   trigger policy / dedupe / autonomy -> real task submission -> durable queue
 *
 *   task incident fingerprint -> real connector context reader -> bounded,
 *   redacted ContextBundle (injected transport; no network)
 *
 * Every clock, id source and payload is fixed, and the JSON summary contains no
 * timestamps, task ids or wall-clock durations. Run it twice and diff.
 *
 * Usage:
 *   bun scripts/bench-connectors.ts
 *   BENCH_LIVE=1 bun scripts/bench-connectors.ts   # prints "skipped"; never calls a vendor
 *
 * Live mode is intentionally inert: a live connector run needs explicit user
 * approval and device-held credentials, so this harness refuses to start one.
 */

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const NOW = new Date(NOW_MS);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const NOW_ISO = NOW.toISOString();

const GENERIC_SECRET = "fabricated-generic-secret-0123456789abcdef";
const GITHUB_SECRET = "fabricated-github-webhook-secret-0123456789";
const SENTRY_SECRET = "fabricated-sentry-secret-0123456789";
const GRAFANA_SECRET = "fabricated-grafana-secret-0123456789abcdef";
const PAGERDUTY_SECRET = "fabricated-pagerduty-secret-0123456789abcdef";

const ORGANIZATION_ID = localDemo.organizationId;
const TASK_ID = asTaskId("00000000-0000-4000-8000-000000000001");

const route: IncidentRepositoryRoute = {
	organizationId: ORGANIZATION_ID,
	repositoryId: localDemo.repositoryId,
	branch: "isolate/incident",
	workflowDefinitionId: localDemo.workflowDefinitionId,
	workflowVersion: localDemo.workflowVersion,
	fileOwnership: [],
};

const scope = {
	organizationId: ORGANIZATION_ID,
	userId: localDemo.userId,
	role: "owner" as const,
};

// ---------------------------------------------------------------------------
// Summary contracts
// ---------------------------------------------------------------------------

export type ScenarioGroup = "intake" | "evidence";

export type ScenarioResult = {
	name: string;
	group: ScenarioGroup;
	pass: boolean;
	/** Stable, bounded explanation; never provider text or an id. */
	detail: string;
	taskCount: number;
	jobCount: number;
	evidenceItems: number;
	evidenceBytes: number;
	evidenceTokens: number;
	evidenceKinds: string[];
	evidenceDigest: string | null;
};

export type BenchSummary = {
	schema: "isolate.bench.connectors.v1";
	mode: "offline";
	providerCalls: 0;
	liveMode: false;
	scenarios: ScenarioResult[];
	totals: { scenarios: number; passed: number; failed: number };
};

function result(
	overrides: Partial<ScenarioResult> &
		Pick<ScenarioResult, "name" | "group" | "pass" | "detail">,
): ScenarioResult {
	return {
		taskCount: 0,
		jobCount: 0,
		evidenceItems: 0,
		evidenceBytes: 0,
		evidenceTokens: 0,
		evidenceKinds: [],
		evidenceDigest: null,
		...overrides,
	};
}

function boundedError(error: unknown): string {
	const message = error instanceof Error ? error.message : "unknown error";
	return message.length > 120 ? `${message.slice(0, 119)}…` : message;
}

/** Deterministic evidence digest: kinds + excerpts only, never fetchedAt/url. */
function digestBundle(bundle: ContextBundle): string {
	const kinds = bundle.items.map((item) => item.kind).join(",");
	const excerpts = bundle.items.map((item) => item.excerpt).join("\u0000");
	return createHash("sha256")
		.update(`${bundle.incidentFingerprint}\n${kinds}\n`)
		.update(excerpts)
		.digest("hex");
}

function summarizeBundle(
	name: string,
	bundle: ContextBundle,
	minItems = 1,
): ScenarioResult {
	const excerpts = bundle.items.map((item) => item.excerpt).join("");
	const bytes = new TextEncoder().encode(excerpts).byteLength;
	const parsed = contextBundleSchema.safeParse(bundle);
	return result({
		name,
		group: "evidence",
		pass: parsed.success && bundle.items.length >= minItems,
		detail: parsed.success
			? bundle.truncated
				? "contract_valid_partial"
				: "contract_valid_complete"
			: "contract_invalid",
		evidenceItems: bundle.items.length,
		evidenceBytes: bytes,
		evidenceTokens: Math.ceil(bytes / 4),
		evidenceKinds: bundle.items.map((item) => item.kind),
		evidenceDigest: digestBundle(bundle),
	});
}

// ---------------------------------------------------------------------------
// Offline control plane (task service + in-memory stores)
// ---------------------------------------------------------------------------

class CountingTasks extends InMemoryTaskRepository {
	created = 0;
	override async create(
		...args: Parameters<InMemoryTaskRepository["create"]>
	) {
		this.created += 1;
		return super.create(...args);
	}
}

class CountingQueue extends InMemoryQueueRepository {
	enqueued = 0;
	override async enqueue(
		...args: Parameters<InMemoryQueueRepository["enqueue"]>
	) {
		this.enqueued += 1;
		return super.enqueue(...args);
	}
}

async function buildControlPlane() {
	const tasks = new CountingTasks();
	const queue = new CountingQueue();
	const clock = () => new Date(NOW_MS);
	const pin = {
		organizationId: scope.organizationId,
		workflowDefinitionId: localDemo.workflowDefinitionId,
		workflowVersion: localDemo.workflowVersion,
	};
	const compilationRepos = createInMemoryWorkflowCompilationRepositories({
		versions: [pin],
	});
	const compileSubmission = createSubmissionCompiler({
		getRepositories: async () => ({
			authoredVersions: createDevelopmentAuthoredVersions(),
			compiledPlans: compilationRepos.compiledPlans,
			rejections: compilationRepos.rejections,
		}),
		authorizeMembership: async (caller) =>
			caller.organizationId === scope.organizationId &&
			caller.userId === scope.userId,
	});
	const store = createRepositoryStore({
		tasks,
		queue,
		approvals: new InMemoryApprovalRepository(clock),
		lifecycle: new InMemoryExecutionLifecycle({
			tasks,
			artifacts: new InMemoryArtifactRepository(tasks, clock),
			clock,
		}),
		repositoryBelongsToOrganization: async (organizationId, repositoryId) =>
			organizationId === scope.organizationId &&
			repositoryId === localDemo.repositoryId,
		compileSubmission,
		listLatest: async () => [],
	});
	const service = createTaskService({
		resolveScope: async () => scope,
		getStore: async () => store,
	});
	return { service, tasks, queue };
}

/** Fake signal store: 30-minute bucketed dedupe plus the per-org cap. */
function fakeIncidentRepository(options: { active?: number } = {}): {
	repository: IncidentRepository;
} {
	const recorded = new Set<string>();
	const repository: IncidentRepository = {
		async recordIfNew(input) {
			const bucket = Math.floor(
				(input.receivedAt ?? NOW).getTime() / (30 * 60 * 1000),
			);
			const key = `${input.organizationId}:${input.source}:${input.fingerprint}:${bucket}`;
			if (recorded.has(key))
				return { ok: true, signalId: "signal-existing", created: false };
			recorded.add(key);
			return { ok: true, signalId: crypto.randomUUID(), created: true };
		},
		async getLatestSignal() {
			return null;
		},
		async reserveIfNewUnderCap(input) {
			if ((options.active ?? 0) >= input.maxActive) {
				return { ok: true, signalId: null, created: false, capped: true };
			}
			const row = await repository.recordIfNew(input);
			return { ...row, capped: false };
		},
		async countActiveIncidentTasks() {
			return options.active ?? 0;
		},
	};
	return { repository };
}

function intakeDependencies(
	h: Awaited<ReturnType<typeof buildControlPlane>>,
	overrides: Partial<IncidentIntakeDependencies> = {},
): IncidentIntakeDependencies {
	return {
		signingSecret: GENERIC_SECRET,
		githubSecret: GITHUB_SECRET,
		sentrySecret: SENTRY_SECRET,
		grafanaSecret: GRAFANA_SECRET,
		pagerdutySecret: PAGERDUTY_SECRET,
		grafanaAllowUnsigned: false,
		binding: {
			organizationId: ORGANIZATION_ID,
			userId: scope.userId,
			role: "member",
		},
		resolveRepository: async () => route,
		incidentRepository: fakeIncidentRepository().repository,
		dedupe: createInMemoryIncidentDedupeStore(),
		submitTask: (input) => h.service.submit(input),
		now: () => NOW,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Signed deliveries
// ---------------------------------------------------------------------------

type Delivery = { rawBody: string; headers: Headers };

function genericSignal(
	source: IncidentSource,
	fingerprint: string,
	service = "checkout-api",
) {
	return incidentSignalSchema.parse({
		source,
		kind: "incident_triggered",
		severity: "high",
		service,
		fingerprint,
		title: `${source} incident: ${service} degraded`,
		summary: "Synthetic benchmark signal; contains no provider data.",
		links: [
			{
				label: "Source",
				url: `https://example.invalid/${source}/${encodeURIComponent(fingerprint)}`,
			},
		],
		receivedAt: NOW_ISO,
	});
}

function genericDelivery(
	payload: unknown,
	options: { secret?: string; timestamp?: number } = {},
): Delivery {
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

function githubDelivery(payload: unknown): Delivery {
	const rawBody = JSON.stringify(payload);
	const signature = createHmac("sha256", GITHUB_SECRET)
		.update(rawBody)
		.digest("hex");
	const headers = new Headers();
	headers.set("x-github-event", "workflow_run");
	headers.set("x-github-delivery", "bench-delivery-1");
	headers.set("x-hub-signature-256", `sha256=${signature}`);
	return { rawBody, headers };
}

function sentryDelivery(payload: unknown, signature?: string): Delivery {
	const rawBody = JSON.stringify(payload);
	const headers = new Headers();
	headers.set("sentry-hook-resource", "issue");
	headers.set("sentry-hook-timestamp", String(NOW_SECONDS));
	headers.set(
		"sentry-hook-signature",
		signature ??
			createHmac("sha256", SENTRY_SECRET).update(rawBody).digest("hex"),
	);
	return { rawBody, headers };
}

function grafanaDelivery(payload: unknown): Delivery {
	const rawBody = JSON.stringify(payload);
	const timestamp = String(NOW_SECONDS);
	const signature = createHmac("sha256", GRAFANA_SECRET)
		.update(`${timestamp}:`)
		.update(rawBody)
		.digest("hex");
	const headers = new Headers();
	headers.set("x-grafana-alerting-timestamp", timestamp);
	headers.set("x-grafana-alerting-signature", signature);
	return { rawBody, headers };
}

function pagerDutyDelivery(payload: unknown, signature?: string): Delivery {
	const rawBody = JSON.stringify(payload);
	const headers = new Headers();
	headers.set(
		"x-pagerduty-signature",
		signature ??
			`v1=${createHmac("sha256", PAGERDUTY_SECRET).update(rawBody).digest("hex")}`,
	);
	return { rawBody, headers };
}

// ---------------------------------------------------------------------------
// Intake payload fixtures
// ---------------------------------------------------------------------------

function workflowPayload() {
	return {
		action: "completed",
		repository: {
			name: "checkout-api",
			full_name: "owner/checkout-api",
			default_branch: "main",
			html_url: "https://github.com/owner/checkout-api",
		},
		workflow_run: {
			id: 42,
			name: "CI",
			head_branch: "main",
			head_sha: "a".repeat(40),
			conclusion: "failure",
			html_url: "https://github.com/owner/checkout-api/actions/runs/42",
		},
	};
}

function sentryPayload() {
	return {
		action: "created",
		issue: {
			id: "4501",
			shortId: "CHECKOUT-1",
			title: "TypeError: cannot read properties of undefined",
			level: "error",
			status: "unresolved",
			permalink: "https://sentry.io/organizations/acme/issues/4501/",
		},
		organization: { slug: "acme" },
		project: { id: "42", slug: "checkout-api" },
	};
}

function grafanaPayload() {
	return {
		version: "1",
		status: "firing",
		alerts: [
			{
				status: "firing",
				labels: {
					alertname: "HighErrorRate",
					service: "checkout-api",
					environment: "production",
					severity: "critical",
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

function pagerDutyPayload() {
	return {
		event: {
			id: "evt-0001",
			event_type: "incident.triggered",
			resource_type: "incident",
			occurred_at: NOW_ISO,
			data: {
				id: "PINC123",
				status: "triggered",
				title: "Checkout latency above SLO",
				urgency: "high",
				service: { id: "PSVC123", name: "checkout-api" },
				created_at: NOW_ISO,
				html_url: "https://acme.pagerduty.com/incidents/PINC123",
			},
		},
	};
}

function outcomeOf(
	value: Awaited<ReturnType<typeof acceptIncident>>,
): string {
	if (!value.ok) return `rejected:${value.code}`;
	if ("taskId" in value) return value.deduped ? "deduped" : "task_created";
	if ("ignored" in value && value.ignored === true) return "ignored";
	if ("throttled" in value && value.throttled === true) return "throttled";
	return "accepted_no_task";
}

async function runIntakeScenario(
	name: string,
	delivery: Delivery,
	options: {
		overrides?: Partial<IncidentIntakeDependencies>;
		replay?: Delivery;
		expectOutcome: string;
		expectTasks: number;
	},
): Promise<ScenarioResult> {
	const h = await buildControlPlane();
	const deps = intakeDependencies(h, options.overrides);
	try {
		const first = await acceptIncident(deps, delivery);
		let outcome = outcomeOf(first);
		if (options.replay !== undefined) {
			const second = await acceptIncident(
				{ ...deps, now: () => new Date(NOW_MS + 60_000) },
				options.replay,
			);
			outcome = `${outcome}+${outcomeOf(second)}`;
		}
		return result({
			name,
			group: "intake",
			pass:
				outcome === options.expectOutcome &&
				h.tasks.created === options.expectTasks,
			detail: `${outcome};tasks=${h.tasks.created};jobs=${h.queue.enqueued}`,
			taskCount: h.tasks.created,
			jobCount: h.queue.enqueued,
		});
	} catch (error) {
		return result({
			name,
			group: "intake",
			pass: false,
			detail: `error:${boundedError(error)}`,
			taskCount: h.tasks.created,
			jobCount: h.queue.enqueued,
		});
	}
}

async function intakeScenarios(): Promise<ScenarioResult[]> {
	const results: ScenarioResult[] = [];
	results.push(
		await runIntakeScenario(
			"intake/github-workflow-failure",
			githubDelivery(workflowPayload()),
			{ expectOutcome: "task_created", expectTasks: 1 },
		),
	);
	results.push(
		await runIntakeScenario(
			"intake/sentry-issue-created",
			sentryDelivery(sentryPayload()),
			{ expectOutcome: "task_created", expectTasks: 1 },
		),
	);
	results.push(
		await runIntakeScenario(
			"intake/grafana-firing-alert",
			grafanaDelivery(grafanaPayload()),
			{ expectOutcome: "task_created", expectTasks: 1 },
		),
	);
	results.push(
		await runIntakeScenario(
			"intake/pagerduty-triggered",
			pagerDutyDelivery(pagerDutyPayload()),
			{ expectOutcome: "task_created", expectTasks: 1 },
		),
	);

	// Vendors without a native signed mode arrive through the generic bridge.
	for (const [source, fingerprint] of [
		["datadog", "datadog:1234567890:abc"],
		["newrelic", "newrelic:NDQ2NjA0fEFQTXxBUFBMSUNBVElPTnwxNjI"],
		["honeycomb", "honeycomb:checkout:trg-1:triggered"],
		["axiom", "axiom:mon-1:abc"],
		["signoz", "signoz:rule-1:abc"],
		["kubernetes", "k8s:prod-eu:payments:pod/api-7c9f-abc:CrashLoopBackOff"],
	] as const) {
		results.push(
			await runIntakeScenario(
				`intake/generic-${source}`,
				genericDelivery(genericSignal(source, fingerprint)),
				{ expectOutcome: "task_created", expectTasks: 1 },
			),
		);
	}

	results.push(
		await runIntakeScenario(
			"intake/bad-signature-rejected",
			{
				rawBody: JSON.stringify(genericSignal("datadog", "datadog:bad")),
				headers: (() => {
					const headers = new Headers();
					headers.set(WEBHOOK_TIMESTAMP_HEADER, String(NOW_SECONDS));
					headers.set(WEBHOOK_SIGNATURE_HEADER, `sha256=${"ab".repeat(32)}`);
					return headers;
				})(),
			},
			{ expectOutcome: "rejected:UNAUTHORIZED", expectTasks: 0 },
		),
	);

	const replaySignal = genericSignal("signoz", "signoz:rule-1:replay");
	const replayDelivery = genericDelivery(replaySignal);
	results.push(
		await runIntakeScenario("intake/replay-deduped", replayDelivery, {
			replay: genericDelivery(replaySignal, { timestamp: NOW_SECONDS + 60 }),
			expectOutcome: "task_created+deduped",
			expectTasks: 1,
		}),
	);

	results.push(await autonomyScenario());
	return results;
}

async function autonomyScenario(): Promise<ScenarioResult> {
	const name = "intake/autonomy-a1-unsupported";
	const h = await buildControlPlane();
	const ledger = createInMemoryEventDeliveryLedger();
	const subscription: IntegrationSubscriptionRecord = {
		id: "sub-1",
		organizationId: ORGANIZATION_ID,
		connectorId: "sentry",
		displayName: "Production incidents",
		eventKinds: [],
		environmentAllowlist: [...DEFAULT_SUBSCRIPTION_ENVIRONMENTS],
		minSeverity: DEFAULT_SUBSCRIPTION_MIN_SEVERITY,
		repositoryId: null,
		baseBranch: null,
		autonomyLevel: "A1",
		enabled: true,
	};
	const subscriptions: SubscriptionRegistry = {
		async listEnabled(input) {
			return input.connectorId === subscription.connectorId &&
				input.organizationId === ORGANIZATION_ID
				? [subscription]
				: [];
		},
	};
	const deps = intakeDependencies(h, {
		subscriptions,
		deliveries: ledger,
		recordTaskAutonomy: async () => {},
	});
	try {
		const outcome = outcomeOf(
			await acceptIncident(
				deps,
				genericDelivery(genericSignal("sentry", "sentry:acme:42:4501")),
			),
		);
		const row = ledger.rows()[0];
		const pass =
			outcome === "ignored" &&
			h.tasks.created === 0 &&
			row?.status === "ignored" &&
			row?.reasonCode === "AUTONOMY_LEVEL_UNSUPPORTED";
		return result({
			name,
			group: "intake",
			pass,
			detail: `${outcome};reason=${row?.reasonCode ?? "none"};tasks=0`,
			taskCount: h.tasks.created,
			jobCount: h.queue.enqueued,
		});
	} catch (error) {
		return result({
			name,
			group: "intake",
			pass: false,
			detail: `error:${boundedError(error)}`,
			taskCount: h.tasks.created,
			jobCount: h.queue.enqueued,
		});
	}
}

// ---------------------------------------------------------------------------
// Evidence fixtures and injected transports (no network)
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function urlOf(input: string | URL | Request): string {
	return input instanceof Request ? input.url : input.toString();
}

function sentryReaderFetch(): FetchLike {
	const issue = {
		id: "467",
		shortId: "CHECKOUT-1",
		title: "TypeError: cannot read id",
		culprit: "app/checkout.js in submit",
		permalink: "https://sentry.io/organizations/acme/issues/467/",
		level: "error",
		status: "unresolved",
		firstSeen: "2026-10-30T10:00:00Z",
		lastSeen: "2026-10-31T09:00:00Z",
		count: 12,
		metadata: {
			value: "Cannot read properties of undefined (reading 'id')",
			type: "TypeError",
			filename: "app/checkout.js",
		},
		project: { id: "450", slug: "checkout", name: "Checkout" },
	};
	const event = {
		eventID: "abcdef0123456789abcdef0123456789",
		message: "TypeError for alice@example.com from 10.0.0.5",
		title: "TypeError: cannot read id",
		culprit: "app/checkout.js in submit",
		level: "error",
		release: { version: "1.2.3" },
		tags: [
			{ key: "environment", value: "production" },
			{ key: "release", value: "1.2.3" },
		],
		entries: [
			{
				type: "exception",
				data: {
					values: [
						{
							type: "TypeError",
							value: "Cannot read id",
							stacktrace: {
								frames: Array.from({ length: 6 }, (_, index) => ({
									filename: `app/src/frame${index}.ts`,
									function: `frame${index}`,
									lineNo: index + 1,
									colNo: 1,
									inApp: true,
								})),
							},
						},
					],
				},
			},
		],
	};
	const release = {
		version: "1.2.3",
		dateCreated: "2026-10-29T10:00:00Z",
		dateReleased: "2026-10-29T11:00:00Z",
		lastEvent: "2026-10-31T09:00:00Z",
		projects: [{ slug: "checkout", name: "Checkout" }],
	};
	const deploys = [
		{
			environment: "production",
			name: "deploy-1.2.3",
			url: "https://deploys.example/build/1",
			dateStarted: "2026-10-30T10:00:00Z",
			dateFinished: "2026-10-30T10:05:00Z",
		},
	];
	return async (input) => {
		const url = urlOf(input);
		if (url.includes("/events/latest/")) return json(200, event);
		if (url.includes("/deploys/")) return json(200, deploys);
		if (url.includes("/releases/")) return json(200, release);
		if (url.includes("/issues/467/")) return json(200, issue);
		return json(404, { detail: "not found" });
	};
}

function grafanaReaderFetch(): FetchLike {
	const rule = {
		uid: "rule-checkout-errors",
		title: "Checkout error rate",
		condition: "C",
		for: "5m",
		ruleGroup: "checkout",
		folderUID: "folder-1",
		labels: { severity: "critical" },
		annotations: {
			summary: "5xx above SLO",
			description: "error ratio 12%",
		},
	};
	const metricFrames = [
		{
			schema: {
				fields: [
					{ name: "Time", type: "time" },
					{
						name: "metric_0",
						type: "number",
						labels: { job: "checkout" },
					},
				],
			},
			data: {
				values: [
					Array.from({ length: 3 }, (_, index) => NOW_MS - (2 - index) * 60_000),
					[1, 2, 3],
				],
			},
		},
	];
	const logFrames = [
		{
			schema: {
				fields: [
					{ name: "Time", type: "time" },
					{ name: "Line", type: "string" },
				],
			},
			data: {
				values: [
					Array.from({ length: 3 }, (_, index) => NOW_MS - index * 1000),
					["line-0 token=redact-me", "line-1", "line-2"],
				],
			},
		},
	];
	return async (input, init) => {
		const url = urlOf(input);
		if (url.includes("/api/v1/provisioning/alert-rules/")) return json(200, rule);
		if (url.endsWith("/api/ds/query")) {
			const body: unknown =
				typeof init?.body === "string" ? JSON.parse(init.body) : null;
			const refId =
				body !== null && typeof body === "object"
					? (body as { queries?: Array<{ refId?: string }> }).queries?.[0]
							?.refId
					: undefined;
			if (refId === "logs") {
				return json(200, {
					results: { logs: { status: 200, frames: logFrames } },
				});
			}
			return json(200, {
				results: { metrics: { status: 200, frames: metricFrames } },
			});
		}
		return json(404, { message: "not found" });
	};
}

function pagerDutyReaderFetch(): FetchLike {
	const incident = {
		incident: {
			id: "PABC123",
			number: 42,
			status: "triggered",
			title: "Checkout latency above SLO",
			urgency: "high",
			priority: { id: "PPRIO1", name: "P1" },
			service: {
				id: "PSVC1",
				name: "checkout",
				html_url: "https://acme.pagerduty.com/services/PSVC1",
				escalation_policy: { id: "PEP1", name: "Primary" },
			},
			created_at: "2026-10-30T23:59:00Z",
			updated_at: NOW_ISO,
			html_url: "https://acme.pagerduty.com/incidents/PABC123",
		},
	};
	return async (input) => {
		const url = urlOf(input);
		if (url.includes("/log_entries")) {
			return json(200, {
				log_entries: Array.from({ length: 5 }, (_, index) => ({
					id: `PLOG${index}`,
					type: "incident.triggered",
					created_at: new Date(NOW_MS - index * 60_000).toISOString(),
					agent: { id: "PUSER1", type: "user" },
				})),
				more: false,
			});
		}
		if (url.includes("/escalation_policies/"))
			return json(200, { escalation_policy: { id: "PEP1", name: "Primary" } });
		if (url.includes("/services/"))
			return json(200, {
				service: {
					id: "PSVC1",
					name: "checkout",
					html_url: "https://acme.pagerduty.com/services/PSVC1",
					escalation_policy: { id: "PEP1", name: "Primary" },
				},
			});
		if (url.includes("/incidents/")) return json(200, incident);
		return json(404, { error: "not found" });
	};
}

function githubReaderFetch(): FetchLike {
	const shaMain = "1".repeat(40);
	const shaRun = "2".repeat(40);
	const files: Record<string, string> = {
		".github/CODEOWNERS": "* @acme/core\n",
		".github/CONTRIBUTING.md": "# Contributing\n\nRun the tests.\n",
	};
	return async (input) => {
		const url = urlOf(input);
		if (url === "https://api.github.com/repos/acme/widgets")
			return json(200, {
				name: "widgets",
				full_name: "acme/widgets",
				default_branch: "main",
				html_url: "https://github.com/acme/widgets",
			});
		if (url.includes("/actions/runs/2/jobs"))
			return json(200, {
				jobs: [
					{
						id: 100,
						name: "build",
						status: "completed",
						conclusion: "failure",
						html_url:
							"https://github.com/acme/widgets/actions/runs/2/job/100",
						steps: [
							{ name: "install", conclusion: "success" },
							{ name: "test", conclusion: "failure" },
						],
					},
				],
			});
		if (url.includes("/actions/runs?"))
			return json(200, {
				workflow_runs: Array.from({ length: 3 }, (_, index) => ({
					id: index + 1,
					name: "CI",
					run_number: index + 1,
					run_attempt: 1,
					event: "push",
					status: "completed",
					conclusion: index === 1 ? "failure" : "success",
					head_branch: "main",
					head_sha: index === 1 ? shaRun : shaMain,
					html_url: `https://github.com/acme/widgets/actions/runs/${index + 1}`,
				})),
			});
		if (url.includes("/check-suites"))
			return json(200, {
				check_suites: [
					{
						id: 99,
						status: "completed",
						conclusion: "failure",
						head_branch: "main",
						head_sha: shaRun,
						html_url: "https://github.com/acme/widgets/runs/99",
						app: { slug: "github-actions", name: "GitHub Actions" },
					},
				],
			});
		if (url.includes("/branches/main/protection"))
			return json(200, {
				required_status_checks: { strict: true, contexts: ["ci"] },
				required_pull_request_reviews: {
					required_approving_review_count: 1,
					dismiss_stale_reviews: true,
				},
				enforce_admins: { enabled: false },
			});
		if (url.includes("/rulesets"))
			return json(200, [
				{ id: 1, name: "default", target: "branch", enforcement: "active" },
			]);
		if (url.includes("/contents/")) {
			const path = decodeURIComponent(
				url.split("/contents/")[1]?.split("?")[0] ?? "",
			);
			const content = files[path];
			if (content === undefined) return json(404, { message: "Not Found" });
			return json(200, {
				type: "file",
				path,
				size: content.length,
				encoding: "base64",
				content: Buffer.from(content, "utf8").toString("base64"),
				html_url: `https://github.com/acme/widgets/blob/main/${path}`,
			});
		}
		if (url.includes("/commits?"))
			return json(200, [
				{
					sha: shaMain,
					commit: { message: "fix: handle incident" },
					author: { login: "octocat" },
				},
			]);
		return json(404, { message: "Not Found" });
	};
}

function datadogReaderFetch(): FetchLike {
	return async (input) => {
		const url = urlOf(input);
		if (url.includes("/api/v2/incidents/"))
			return json(200, {
				data: {
					id: "incident-abc-123",
					type: "incidents",
					attributes: {
						title: "Checkout outage",
						severity: "SEV-1",
						state: "active",
						created: "2026-10-30T23:50:00.000Z",
						modified: NOW_ISO,
						customer_impact_scope:
							"Checkout failing for alice@example.com from 10.1.2.3",
						customer_impacted: true,
					},
				},
			});
		if (url.includes("/api/v1/monitor/"))
			return json(200, {
				id: 1234567890,
				name: "Checkout error rate",
				type: "metric alert",
				overall_state: "Alert",
				priority: 1,
				created: "2026-10-01T00:00:00.000Z",
				modified: NOW_ISO,
				tags: ["service:checkout", "env:prod"],
			});
		if (url.endsWith("/api/v2/query/timeseries"))
			return json(200, {
				data: {
					id: "query-1",
					type: "timeseries_response",
					attributes: {
						query: "avg:system.cpu.user{service:checkout}",
						series: [
							{
								query_index: 0,
								aggr: "avg",
								scope: "avg:system.cpu.user{service:checkout}",
								pointlist: Array.from({ length: 3 }, (_, index) => [
									NOW_MS - (2 - index) * 60_000,
									10 + index,
								]),
							},
						],
					},
				},
			});
		if (url.endsWith("/api/v2/logs/events/search"))
			return json(200, {
				data: Array.from({ length: 5 }, (_, index) => ({
					id: `log-${index}`,
					type: "log",
					attributes: {
						timestamp: new Date(NOW_MS - index * 1000).toISOString(),
						status: index === 0 ? "error" : "info",
						service: "checkout",
						attributes: { "error.kind": "timeout" },
					},
				})),
				meta: { page: {} },
			});
		return json(404, { errors: ["not found"] });
	};
}

function newRelicReaderFetch(): FetchLike {
	const entity = {
		guid: "NDQ2NjA0fEFQTXxBUFBMSUNBVElPTnwxNjI",
		accountId: 1234567,
		name: "checkout-api",
		type: "APPLICATION",
		domain: "APM",
		alertSeverity: "CRITICAL",
		reporting: true,
		tags: [
			{ key: "service", values: ["checkout"] },
			{ key: "environment", values: ["production"] },
		],
	};
	return async (input, init) => {
		const url = urlOf(input);
		void url;
		let query = "";
		if (typeof init?.body === "string") {
			try {
				const body = JSON.parse(init.body) as { query?: unknown };
				query = typeof body.query === "string" ? body.query : "";
			} catch {
				query = "";
			}
		}
		if (query.includes("entity(guid"))
			return json(200, { data: { actor: { entity } } });
		if (query.includes("entitySearch"))
			return json(200, {
				data: {
					actor: {
						entitySearch: {
							count: 1,
							results: { entities: [entity] },
						},
					},
				},
			});
		if (query.includes("nrql(query"))
			return json(200, {
				data: {
					actor: {
						account: {
							nrql: {
								results: [
									{ count: 12, "error.class": "TimeoutError" },
									{ count: 3, "error.class": "ConnectionReset" },
								],
							},
						},
					},
				},
			});
		return json(400, {});
	};
}

function honeycombReaderFetch(): FetchLike {
	const series = [
		{
			name: {
				"service.name": "checkout-api",
				"http.route": "/pay",
				"host.name": "db.internal",
			},
			data: [{ time: NOW_ISO, P95: 120, count: 7 }],
		},
	];
	return async (input, init) => {
		const url = urlOf(input);
		const path = new URL(url).pathname;
		const method = init?.method ?? "GET";
		if (method === "POST" && path === "/1/queries/checkout")
			return json(200, { id: "query-1" });
		if (method === "POST" && path === "/1/query_results/checkout")
			return json(200, { id: "result-1", complete: true });
		if (method === "GET" && path === "/1/query_results/checkout/result-1")
			return json(200, {
				id: "result-1",
				complete: true,
				data: { series },
			});
		if (method === "GET" && path === "/1/slos/checkout")
			return json(200, [
				{
					id: "slo-1",
					name: "Checkout availability",
					target: 0.999,
					current: 0.9995,
					status: "ok",
					time_window_days: 30,
				},
			]);
		return json(404, { message: "not found" });
	};
}

function axiomReaderFetch(): FetchLike {
	return async (input) => {
		const url = urlOf(input);
		if (url.endsWith("/v1/datasets"))
			return json(200, {
				datasets: [{ id: "ds-1", name: "app-logs" }],
			});
		if (url.endsWith("/v1/query/_apl?format=tabular"))
			return json(200, {
				matches: [
					{
						fields: ["service", "environment", "status", "error_kind", "count"],
						data: [
							["checkout", "production", "500", "timeout", 12],
							["checkout", "production", "500", "timeout", 8],
						],
					},
				],
			});
		return json(404, { message: "not found" });
	};
}

function signozReaderFetch(): FetchLike {
	return async (input) => {
		const url = urlOf(input);
		if (url === "https://signoz.example.com/api/v1/rules/rule-checkout-errors")
			return json(200, {
				status: "success",
				data: {
					id: "rule-checkout-errors",
					alertName: "HighErrorRate",
					ruleType: "promql_rule",
					alert: 'sum(rate(http_requests_total{service_name="checkout"}[5m]))',
					state: "firing",
					evalWindow: "5m0s",
					frequency: "1m0s",
					description: "Error rate above 5% for service checkout",
					labels: { "service.name": "checkout", severity: "critical" },
					annotations: { summary: "Error rate above 5%" },
				},
			});
		if (url === "https://signoz.example.com/api/v5/query_range")
			return json(200, {
				status: "success",
				data: {
					type: "time_series",
					data: {
						results: [
							{
								queryName: "A",
								series: [
									{
										labels: {
											service_name: "checkout",
											operation: "GET /pay",
											status_code: "500",
										},
										values: [
											{ timestamp: NOW_MS - 60_000, value: "1.5" },
											{ timestamp: NOW_MS, value: "2.5" },
										],
									},
								],
							},
						],
					},
				},
			});
		return json(404, { status: "error" });
	};
}

function kubernetesFakeClient(): KubernetesHttpClient {
	const eventList = {
		metadata: { resourceVersion: "100" },
		items: [
			{
				metadata: {
					name: "api.1",
					namespace: "payments",
					uid: "event-1",
					creationTimestamp: "2026-10-30T23:00:00Z",
				},
				involvedObject: {
					kind: "Pod",
					name: "api-7c9f-abc",
					namespace: "payments",
					uid: "pod-uid",
				},
				reason: "CrashLoopBackOff",
				message: "Back-off restarting failed container",
				type: "Warning",
				count: 1,
				firstTimestamp: "2026-10-30T23:00:00Z",
				lastTimestamp: "2026-10-30T23:01:00Z",
			},
		],
	};
	const pod = {
		metadata: {
			name: "api-7c9f-abc",
			namespace: "payments",
			uid: "pod-uid",
			labels: { app: "api" },
		},
		spec: {
			containers: [
				{
					name: "api",
					image: "registry.example.com/api:v1",
					resources: { limits: { memory: "128Mi", cpu: "250m" } },
				},
			],
		},
		status: {
			phase: "Running",
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
					state: { waiting: { reason: "CrashLoopBackOff" } },
					lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
				},
			],
		},
	};
	const deployment = {
		metadata: { name: "api", namespace: "payments", generation: 5 },
		spec: { replicas: 3, selector: { matchLabels: { app: "api" } } },
		status: {
			observedGeneration: 4,
			replicas: 4,
			readyReplicas: 1,
			availableReplicas: 1,
			unavailableReplicas: 2,
			updatedReplicas: 3,
		},
	};
	const replicaSets = {
		items: [
			{
				metadata: {
					name: "api-1",
					namespace: "payments",
					uid: "rs-1",
					annotations: { "deployment.kubernetes.io/revision": "1" },
					ownerReferences: [
						{ kind: "Deployment", name: "api", uid: "dep-uid" },
					],
				},
				spec: { replicas: 3 },
				status: { replicas: 3, readyReplicas: 1, availableReplicas: 1 },
			},
		],
	};
	return {
		async get(path) {
			if (path.endsWith("/events")) return { status: 200, body: eventList };
			if (path.includes("/pods/")) return { status: 200, body: pod };
			if (path.includes("/deployments/"))
				return { status: 200, body: deployment };
			if (path.endsWith("/replicasets"))
				return { status: 200, body: replicaSets };
			return { status: 404, body: {} };
		},
		async getText() {
			return {
				status: 200,
				text: "2026-10-30T23:00:00Z panic: timeout password=hunter2",
			};
		},
	};
}

async function evidenceScenario(
	name: string,
	load: () => Promise<ContextBundle>,
	minItems = 1,
): Promise<ScenarioResult> {
	try {
		return summarizeBundle(name, await load(), minItems);
	} catch (error) {
		return result({
			name,
			group: "evidence",
			pass: false,
			detail: `error:${boundedError(error)}`,
		});
	}
}

async function evidenceScenarios(): Promise<ScenarioResult[]> {
	const now = () => NOW_MS;
	const results: ScenarioResult[] = [];
	results.push(
		await evidenceScenario("evidence/github", () =>
			fetchGitHubIncidentContext(
				{
					tokenProvider: {
						async getInstallationToken() {
							return {
								token: "ghs_fixture_token",
								expiresAt: "2026-10-31T01:00:00Z",
							};
						},
					},
					fetchImpl: githubReaderFetch() as unknown as typeof fetch,
					now,
				},
				{
					repositoryFullName: "acme/widgets",
					ref: "refs/heads/main",
					incidentFingerprint: "github:acme/widgets:CI:main",
				},
			),
		),
	);
	results.push(
		await evidenceScenario("evidence/sentry", () =>
			fetchSentryContext(
				{
					token: "sentry-fixture-token",
					fetchImpl: sentryReaderFetch() as unknown as typeof fetch,
					now,
				},
				{
					orgSlug: "acme",
					issueId: "467",
					incidentFingerprint: "sentry:acme:450:467",
				},
			),
		),
	);
	results.push(
		await evidenceScenario("evidence/grafana", () =>
			fetchGrafanaContext(
				{
					baseUrl: "https://grafana.example.com",
					token: "glsa_fixture_token",
					orgId: 42,
					metricsDatasourceUid: "prom-uid",
					logsDatasourceUid: "loki-uid",
					fetchImpl: grafanaReaderFetch() as unknown as typeof fetch,
					now,
				},
				{
					incidentFingerprint: "grafana:rule-checkout-errors:abc",
					service: "checkout",
					alertRuleUid: "rule-checkout-errors",
					startsAt: "2026-10-30T23:50:00Z",
				},
			),
		),
	);
	results.push(
		await evidenceScenario("evidence/pagerduty", () =>
			fetchPagerDutyContext(
				{
					token: "pd-fixture-token",
					baseUrl: "https://pd.test",
					fromEmail: "ops@example.invalid",
					fetchImpl: pagerDutyReaderFetch() as unknown as typeof fetch,
					now,
				},
				{
					incidentId: "PABC123",
					incidentFingerprint: "pagerduty:PSVC1:PABC123",
				},
			),
		),
	);
	results.push(
		await evidenceScenario("evidence/datadog", () =>
			fetchDatadogContext(
				{
					baseUrl: "https://api.datadoghq.com",
					apiKey: "fixture-api-key",
					appKey: "fixture-app-key",
					fetchImpl: datadogReaderFetch() as unknown as typeof fetch,
					now,
				},
				{
					incidentFingerprint: "datadog:1234567890:abc",
					service: "checkout",
					incidentId: "incident-abc-123",
					monitorId: "1234567890",
					startsAt: "2026-10-30T23:50:00Z",
				},
			),
		),
	);
	results.push(
		await evidenceScenario("evidence/newrelic", () =>
			fetchNewRelicContext(
				{
					apiKey: "NRAK-fixture-key",
					accountId: "1234567",
					fetchImpl: newRelicReaderFetch() as unknown as typeof fetch,
					now,
				},
				{
					incidentFingerprint: "newrelic:NDQ2NjA0fEFQTXxBUFBMSUNBVElPTnwxNjI",
					service: "checkout",
					entityGuid: "NDQ2NjA0fEFQTXxBUFBMSUNBVElPTnwxNjI",
					startsAt: "2026-10-30T23:45:00.000Z",
					windowMinutes: 30,
				},
			),
		),
	);
	results.push(
		await evidenceScenario("evidence/honeycomb", () =>
			fetchHoneycombIncidentContext(
				{
					apiKey: "hny-fixture-key",
					dataset: "checkout",
					fetchImpl: honeycombReaderFetch(),
					now,
					trigger: {
						id: "trg-1",
						name: "Checkout latency",
						state: "triggered",
						threshold: { op: ">", value: 500 },
						observed: 900,
						url: "https://ui.honeycomb.io/checkout/triggers/trg-1",
					},
				},
				{
					incidentFingerprint: "honeycomb:checkout:trg-1:triggered",
					service: "checkout-api",
					kind: "latency",
					windowMinutes: 60,
				},
			),
		),
	);
	results.push(
		await evidenceScenario("evidence/axiom", () =>
			fetchAxiomIncidentContext(
				{
					baseUrl: "https://api.axiom.co",
					token: "xapt_fixture_token",
					dataset: "app-logs",
					allowedDatasets: ["app-logs"],
					fetchImpl: axiomReaderFetch() as unknown as typeof fetch,
					now,
				},
				{
					incidentFingerprint: "axiom:mon-1:abc",
					service: "checkout",
					startsAt: "2026-10-30T23:50:00Z",
				},
			),
		),
	);
	results.push(
		await evidenceScenario("evidence/signoz", () =>
			fetchSignozContext(
				{
					baseUrl: "https://signoz.example.com",
					apiKey: "signoz-fixture-key",
					fetchImpl: signozReaderFetch() as unknown as typeof fetch,
					now,
				},
				{
					incidentFingerprint: "signoz:rule-checkout-errors:abc",
					service: "checkout",
					ruleId: "rule-checkout-errors",
					startsAt: "2026-10-30T23:30:00Z",
					windowMinutes: 30,
				},
			),
		),
	);
	results.push(
		await evidenceScenario("evidence/kubernetes", () =>
			fetchKubernetesContext(
				{
					client: kubernetesFakeClient(),
					namespace: "payments",
					clusterId: "prod-eu",
					now,
				},
				{
					incidentFingerprint:
						"k8s:prod-eu:payments:pod/api-7c9f-abc:CrashLoopBackOff",
					namespace: "payments",
					kind: "Pod",
					name: "api-7c9f-abc",
					podName: "api-7c9f-abc",
					deploymentName: "api",
				},
			),
		),
	);
	results.push(await emptyEvidenceScenario());
	return results;
}

/** No device, no signal, no call: the loader must return null, never a bundle. */
async function emptyEvidenceScenario(): Promise<ScenarioResult> {
	const name = "evidence/empty-device-degrades";
	let enqueued = 0;
	const broker: ConnectorContextDependencies["broker"] = {
		async resolve() {
			return {
				deviceId: null,
				credentialId: null,
				credentialRef: "none",
				scopes: [],
				metadata: {},
				proxy: {} as never,
			};
		},
	};
	const calls: ConnectorContextDependencies["calls"] = {
		async enqueue() {
			enqueued += 1;
			throw new Error("must not enqueue without a device");
		},
		async awaitResult() {
			return null;
		},
	};
	const signals: ConnectorContextDependencies["signals"] = {
		async getLatestSignal() {
			return null;
		},
	};
	try {
		const loader = createConnectorContextLoader({
			broker,
			calls,
			signals,
			now: () => NOW_MS,
		});
		const bundle = await loader({
			organizationId: ORGANIZATION_ID as OrganizationId,
			taskId: TASK_ID as TaskId,
			incidentFingerprint: "datadog:1234567890:abc",
		});
		return result({
			name,
			group: "evidence",
			pass: bundle === null && enqueued === 0,
			detail: bundle === null ? "no_evidence_no_call" : "unexpected_bundle",
		});
	} catch (error) {
		return result({
			name,
			group: "evidence",
			pass: false,
			detail: `error:${boundedError(error)}`,
		});
	}
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function sorted(results: ScenarioResult[]): ScenarioResult[] {
	return [...results].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
}

export async function runBench(): Promise<BenchSummary> {
	const scenarios = sorted([
		...(await intakeScenarios()),
		...(await evidenceScenarios()),
	]);
	return {
		schema: "isolate.bench.connectors.v1",
		mode: "offline",
		providerCalls: 0,
		liveMode: false,
		scenarios,
		totals: {
			scenarios: scenarios.length,
			passed: scenarios.filter((scenario) => scenario.pass).length,
			failed: scenarios.filter((scenario) => !scenario.pass).length,
		},
	};
}

function printHuman(summary: BenchSummary): void {
	console.log("isolate offline connector benchmark");
	console.log(
		`scenarios=${summary.totals.scenarios} passed=${summary.totals.passed} failed=${summary.totals.failed} providerCalls=0`,
	);
	for (const scenario of summary.scenarios) {
		const status = scenario.pass ? "PASS" : "FAIL";
		const evidence =
			scenario.group === "evidence"
				? ` items=${scenario.evidenceItems} bytes=${scenario.evidenceBytes} tokens~${scenario.evidenceTokens}`
				: ` tasks=${scenario.taskCount} jobs=${scenario.jobCount}`;
		console.log(
			`${status} ${scenario.name}${evidence} — ${scenario.detail}`,
		);
	}
}

const PROVIDER_ENV = /^(BASETEN_|MODAL_)/;

async function main(): Promise<number> {
	const live = process.env.BENCH_LIVE !== undefined;
	if (live) {
		// Never start a live run from this harness: it needs explicit approval,
		// device-held credentials and the acceptance checklist.
		console.log("skipped: live mode requires explicit approval");
		return 0;
	}
	const forbidden = Object.keys(process.env).filter((name) =>
		PROVIDER_ENV.test(name),
	);
	if (forbidden.length > 0) {
		console.error(
			`REFUSED: provider environment variables are set (${forbidden.join(", ")}); the offline benchmark needs zero credentials`,
		);
		return 1;
	}
	const summary = await runBench();
	printHuman(summary);
	console.log("BENCH_JSON_BEGIN");
	console.log(JSON.stringify(summary));
	console.log("BENCH_JSON_END");
	return summary.totals.failed === 0 ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await main();
}
