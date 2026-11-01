import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	acknowledgePagerDutyIncident,
	createPagerDutyReadTools,
	PAGERDUTY_ACKNOWLEDGE_TOOL,
	PAGERDUTY_GET_INCIDENT_TOOL,
	PAGERDUTY_LIST_INCIDENTS_TOOL,
	PAGERDUTY_LIST_LOG_ENTRIES_TOOL,
	PAGERDUTY_RESOLVE_TOOL,
	PAGERDUTY_TOOL_RISK_BANDS,
	type PagerDutyReadTool,
	type PagerDutyToolDependencies,
	type PagerDutyWriteAuditEntry,
	type PagerDutyWriteDependencies,
	resolvePagerDutyIncident,
} from "./tools";

const TOKEN = "u+readtoken-0123456789abcdef";
const WRITE_TOKEN = "u+writetoken-0123456789abcdef";
const FROM_EMAIL = "ops@acme.com";
const BASE_URL = "https://pd.test";
const INCIDENT_URL = "https://acme.pagerduty.com/incidents/PABC123";

type FetchCall = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function incident(index = 1): Record<string, unknown> {
	return {
		id: `PABC12${index}`,
		number: index,
		status: "triggered",
		title: `Checkout latency jane@acme.com ${index}`,
		urgency: "high",
		priority: { id: "PPRIO1", name: "P1" },
		service: {
			id: "PSVC1",
			name: "checkout ops@acme.com",
			html_url: "https://acme.pagerduty.com/services/PSVC1",
		},
		created_at: "2026-10-30T23:59:00Z",
		html_url: INCIDENT_URL,
		assignments: [
			{ assignee: { id: "PUSER1", summary: "Alice alice@acme.com" } },
		],
	};
}

type ReadRouterOptions = {
	listCount?: number;
	getStatus?: number;
	logStatus?: number;
};

function readRouter(options: ReadRouterOptions = {}): {
	impl: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });
		if (url.includes("/log_entries")) {
			const status = options.logStatus ?? 200;
			if (status !== 200) return json(status, { error: "nope" });
			return json(200, {
				log_entries: [
					{
						id: "PLOG1",
						type: "incident.triggered",
						created_at: "2026-10-30T23:59:30Z",
						agent: {
							id: "PUSER1",
							type: "user",
							summary: "Alice alice@acme.com +1 415-555-0100",
						},
						channel: { type: "web_trigger" },
						note: "raw note body",
					},
				],
			});
		}
		if (url.startsWith(`${BASE_URL}/incidents?`)) {
			return json(200, {
				incidents: Array.from({ length: options.listCount ?? 30 }, (_, index) =>
					incident(index + 1),
				),
				more: (options.listCount ?? 30) > 25,
			});
		}
		if (url.startsWith(`${BASE_URL}/incidents/`)) {
			const status = options.getStatus ?? 200;
			if (status !== 200) return json(status, { error: "nope" });
			return json(200, { incident: incident() });
		}
		return json(404, { error: "not found" });
	};
	return { impl: impl as unknown as typeof fetch, calls };
}

function readTools(
	impl: typeof fetch,
	overrides: Partial<PagerDutyToolDependencies> = {},
): readonly PagerDutyReadTool[] {
	return createPagerDutyReadTools({
		token: TOKEN,
		baseUrl: BASE_URL,
		fetchImpl: impl,
		...overrides,
	});
}

async function captureError(promise: Promise<unknown>): Promise<PlatformError> {
	try {
		await promise;
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(PlatformError);
		return thrown as PlatformError;
	}
	throw new Error("expected the promise to reject");
}

function requireTool(
	tools: readonly PagerDutyReadTool[],
	name: PagerDutyReadTool["name"],
): PagerDutyReadTool {
	const found = tools.find((tool) => tool.name === name);
	if (found === undefined) throw new Error(`missing tool: ${name}`);
	return found;
}

describe("pagerduty read tools", () => {
	test("declares read_only bands and strict bounded schemas", () => {
		expect(PAGERDUTY_TOOL_RISK_BANDS[PAGERDUTY_LIST_INCIDENTS_TOOL]).toBe(
			"read_only",
		);
		expect(PAGERDUTY_TOOL_RISK_BANDS[PAGERDUTY_GET_INCIDENT_TOOL]).toBe(
			"read_only",
		);
		expect(PAGERDUTY_TOOL_RISK_BANDS[PAGERDUTY_LIST_LOG_ENTRIES_TOOL]).toBe(
			"read_only",
		);
		expect(PAGERDUTY_TOOL_RISK_BANDS[PAGERDUTY_ACKNOWLEDGE_TOOL]).toBe(
			"scoped_write",
		);
		expect(PAGERDUTY_TOOL_RISK_BANDS[PAGERDUTY_RESOLVE_TOOL]).toBe(
			"scoped_write",
		);
	});

	test("list_incidents caps at 25 and returns redacted, allowlisted fields", async () => {
		const { impl, calls } = readRouter();
		const tools = readTools(impl);
		const list = requireTool(tools, PAGERDUTY_LIST_INCIDENTS_TOOL);
		const result = await list.execute({
			limit: 25,
			status: "triggered",
			serviceId: "PSVC1",
		});
		const incidents = result.incidents as Array<Record<string, unknown>>;
		expect(incidents).toHaveLength(25);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("limit=25");
		expect(calls[0]?.url).toContain("statuses%5B%5D=triggered");
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("jane@acme.com");
		expect(serialized).not.toContain("ops@acme.com");
		expect(serialized).not.toContain("PUSER1");
		expect(serialized).not.toContain("assignments");
		expect(incidents[0]?.title).toContain("[email-redacted]");
	});

	test("rejects unknown keys and out-of-range limits before any fetch", async () => {
		const { impl, calls } = readRouter();
		const tools = readTools(impl);
		const list = requireTool(tools, PAGERDUTY_LIST_INCIDENTS_TOOL);
		const get = requireTool(tools, PAGERDUTY_GET_INCIDENT_TOOL);
		const log = requireTool(tools, PAGERDUTY_LIST_LOG_ENTRIES_TOOL);
		for (const [tool, input] of [
			[list, { limit: 26 }],
			[list, { limit: 1, extra: true }],
			[get, { incidentId: "PABC123", extra: true }],
			[get, { incidentId: "bad id" }],
			[log, { incidentId: "PABC123", limit: 21 }],
		] as const) {
			const error = await captureError(tool.execute(input));
			expect(error.code).toBe("VALIDATION_FAILED");
		}
		expect(calls).toHaveLength(0);
	});

	test("get_incident maps 404 to NOT_FOUND and returns bounded evidence", async () => {
		const { impl } = readRouter({ getStatus: 404 });
		const tools = readTools(impl);
		const get = requireTool(tools, PAGERDUTY_GET_INCIDENT_TOOL);
		const error = await captureError(get.execute({ incidentId: "PABC123" }));
		expect(error.code).toBe("NOT_FOUND");

		const success = readRouter();
		const getSuccess = requireTool(
			readTools(success.impl),
			PAGERDUTY_GET_INCIDENT_TOOL,
		);
		const result = await getSuccess.execute({ incidentId: "PABC123" });
		expect(JSON.stringify(result)).not.toContain("assignments");
		expect(JSON.stringify(result)).not.toContain("Alice");
		expect(result.incident).toMatchObject({
			id: "PABC121",
			status: "triggered",
			url: INCIDENT_URL,
		});
	});

	test("list_log_entries returns roles only, never names, notes or contacts", async () => {
		const { impl, calls } = readRouter();
		const tools = readTools(impl);
		const log = requireTool(tools, PAGERDUTY_LIST_LOG_ENTRIES_TOOL);
		const result = await log.execute({ incidentId: "PABC123", limit: 5 });
		expect(calls[0]?.url).toContain("limit=5");
		expect(calls[0]?.url).toContain("is_overview=true");
		expect(result.entries).toEqual([
			{
				id: "PLOG1",
				type: "incident.triggered",
				createdAt: "2026-10-30T23:59:30Z",
				actorRole: "user",
			},
		]);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("Alice");
		expect(serialized).not.toContain("alice@acme.com");
		expect(serialized).not.toContain("415-555-0100");
		expect(serialized).not.toContain("raw note body");
	});

	test("maps optional-resource 403 to POLICY_DENIED", async () => {
		const { impl } = readRouter({ logStatus: 403 });
		const tools = readTools(impl);
		const log = requireTool(tools, PAGERDUTY_LIST_LOG_ENTRIES_TOOL);
		const error = await captureError(log.execute({ incidentId: "PABC123" }));
		expect(error.code).toBe("POLICY_DENIED");
	});
});

type WriteRouterOptions = {
	status?: number;
	body?: unknown;
	stream?: { chunks: readonly string[]; onCancel: () => void };
};

/** Pull-based body: the adapter decides consumption; `onCancel` proves the cap. */
function streamed(chunks: readonly string[], onCancel: () => void): Response {
	const encoder = new TextEncoder();
	let index = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const next = chunks[index];
				if (next === undefined) {
					controller.close();
					return;
				}
				index += 1;
				controller.enqueue(encoder.encode(next));
			},
			cancel() {
				onCancel();
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function writeRouter(options: WriteRouterOptions = {}): {
	impl: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });
		const status = options.status ?? 200;
		if (status !== 200) return json(status, { error: "nope" });
		if (options.stream !== undefined) {
			return streamed(options.stream.chunks, options.stream.onCancel);
		}
		return json(
			200,
			options.body ?? {
				incidents: [{ id: "PABC123", status: "acknowledged" }],
			},
		);
	};
	return { impl: impl as unknown as typeof fetch, calls };
}

function writeDeps(
	impl: typeof fetch,
	audits: PagerDutyWriteAuditEntry[],
	overrides: Partial<PagerDutyWriteDependencies> = {},
): PagerDutyWriteDependencies {
	return {
		token: WRITE_TOKEN,
		fromEmail: FROM_EMAIL,
		baseUrl: BASE_URL,
		fetchImpl: impl,
		audit: (entry) => {
			audits.push(entry);
		},
		organizationId: "org-1",
		taskId: "task-1",
		...overrides,
	};
}

describe("pagerduty scoped writes", () => {
	test("acknowledge uses a separate write token, From header and one status field", async () => {
		const { impl, calls } = writeRouter();
		const audits: PagerDutyWriteAuditEntry[] = [];
		const result = await acknowledgePagerDutyIncident(writeDeps(impl, audits), {
			incidentId: "PABC123",
		});
		expect(result).toEqual({
			ok: true,
			incidentId: "PABC123",
			status: "acknowledged",
		});
		expect(calls).toHaveLength(1);
		const request = calls[0];
		if (request === undefined) throw new Error("missing request");
		expect(request.url).toBe(`${BASE_URL}/incidents`);
		expect(request.init.method).toBe("PUT");
		const headers = request.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Token token=${WRITE_TOKEN}`);
		expect(headers.From).toBe(FROM_EMAIL);
		expect(JSON.parse(String(request.init.body))).toEqual({
			incidents: [
				{ id: "PABC123", type: "incident_reference", status: "acknowledged" },
			],
		});
		expect(audits).toEqual([
			{
				tool: PAGERDUTY_ACKNOWLEDGE_TOOL,
				risk: "scoped_write",
				outcome: "SUCCEEDED",
				incidentId: "PABC123",
				organizationId: "org-1",
				taskId: "task-1",
			},
		]);
		expect(JSON.stringify(audits)).not.toContain(WRITE_TOKEN);
		expect(JSON.stringify(audits)).not.toContain(FROM_EMAIL);
	});

	test("resolve writes the resolved status and audits the action", async () => {
		const { impl } = writeRouter({
			body: { incidents: [{ id: "PABC123", status: "resolved" }] },
		});
		const audits: PagerDutyWriteAuditEntry[] = [];
		const result = await resolvePagerDutyIncident(writeDeps(impl, audits), {
			incidentId: "PABC123",
		});
		expect(result).toEqual({
			ok: true,
			incidentId: "PABC123",
			status: "resolved",
		});
		expect(audits[0]?.tool).toBe(PAGERDUTY_RESOLVE_TOOL);
		expect(audits[0]?.outcome).toBe("SUCCEEDED");
	});

	test("invalid input is blocked and audited without a request", async () => {
		const { impl, calls } = writeRouter();
		const audits: PagerDutyWriteAuditEntry[] = [];
		const result = await acknowledgePagerDutyIncident(writeDeps(impl, audits), {
			incidentId: "bad id",
			extra: true,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("VALIDATION_FAILED");
		expect(calls).toHaveLength(0);
		expect(audits).toEqual([
			{
				tool: PAGERDUTY_ACKNOWLEDGE_TOOL,
				risk: "scoped_write",
				outcome: "BLOCKED",
				incidentId: "unknown",
				code: "VALIDATION_FAILED",
				organizationId: "org-1",
				taskId: "task-1",
			},
		]);
	});

	test("maps 403/404/429 to typed failures and audits each outcome", async () => {
		for (const [status, code] of [
			[403, "POLICY_DENIED"],
			[404, "NOT_FOUND"],
			[429, "RATE_LIMITED"],
		] as const) {
			const { impl } = writeRouter({ status });
			const audits: PagerDutyWriteAuditEntry[] = [];
			const result = await acknowledgePagerDutyIncident(
				writeDeps(impl, audits),
				{ incidentId: "PABC123" },
			);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.code).toBe(code);
			expect(audits[0]?.outcome).toBe("FAILED");
			expect(audits[0]?.code).toBe(code);
			expect(JSON.stringify(audits)).not.toContain(WRITE_TOKEN);
		}
	});

	test("a mismatched write response fails closed", async () => {
		const { impl } = writeRouter({
			body: { incidents: [{ id: "POTHER", status: "acknowledged" }] },
		});
		const audits: PagerDutyWriteAuditEntry[] = [];
		const result = await acknowledgePagerDutyIncident(writeDeps(impl, audits), {
			incidentId: "PABC123",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(audits[0]?.outcome).toBe("FAILED");
	});

	test("reads a multi-chunk write confirmation and never cancels it", async () => {
		const body = JSON.stringify({
			incidents: [{ id: "PABC123", status: "acknowledged" }],
		});
		const midpoint = Math.floor(body.length / 2);
		let cancelled = 0;
		const { impl } = writeRouter({
			stream: {
				chunks: [body.slice(0, midpoint), body.slice(midpoint)],
				onCancel: () => {
					cancelled += 1;
				},
			},
		});
		const audits: PagerDutyWriteAuditEntry[] = [];
		const result = await acknowledgePagerDutyIncident(writeDeps(impl, audits), {
			incidentId: "PABC123",
		});
		expect(result).toEqual({
			ok: true,
			incidentId: "PABC123",
			status: "acknowledged",
		});
		expect(cancelled).toBe(0);
	});

	test("cancels an oversized write confirmation at the cap and fails closed", async () => {
		const secret = "STREAMED-PROVIDER-SECRET";
		let cancelled = 0;
		const { impl } = writeRouter({
			stream: {
				chunks: ['{"incidents":', secret, "x".repeat(100 * 1024)],
				onCancel: () => {
					cancelled += 1;
				},
			},
		});
		const audits: PagerDutyWriteAuditEntry[] = [];
		const result = await acknowledgePagerDutyIncident(writeDeps(impl, audits), {
			incidentId: "PABC123",
		});
		expect(cancelled).toBe(1);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(audits[0]?.outcome).toBe("FAILED");
		expect(JSON.stringify(audits)).not.toContain(secret);
	});

	test("a missing write credential blocks without calling the provider", async () => {
		const { impl, calls } = writeRouter();
		const audits: PagerDutyWriteAuditEntry[] = [];
		const result = await acknowledgePagerDutyIncident(
			writeDeps(impl, audits, { token: "" }),
			{ incidentId: "PABC123" },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(calls).toHaveLength(0);
		expect(audits[0]?.outcome).toBe("BLOCKED");
	});
});
