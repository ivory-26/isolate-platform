import { isBoundedHttpsUrl, PlatformError } from "@isolate/shared";
import { z } from "zod";
import {
	createPagerDutyReadCaller,
	normalizePagerDutyBaseUrl,
	PAGERDUTY_ACCEPT,
	PAGERDUTY_USER_AGENT,
	type PagerDutyCallResult,
	type PagerDutyFetch,
	requirePagerDutyFromEmail,
	requirePagerDutyWriteToken,
} from "./client";
import { redactPagerDutyText } from "./redact";
import {
	PAGERDUTY_RESOURCE_ID_PATTERN,
	type PagerDutyIncident,
	pagerDutyIncidentListResponseSchema,
	pagerDutyIncidentResponseSchema,
	pagerDutyIncidentStatusSchema,
	pagerDutyIncidentWriteResponseSchema,
	pagerDutyLogEntriesResponseSchema,
} from "./schemas";

/**
 * PagerDuty tool surface.
 *
 * Risk bands (the Mastra `ToolName` union and policy table are coordinator-owned;
 * this module only declares the bands so registration cannot silently widen
 * them):
 *
 *  - `pagerduty.list_incidents`, `pagerduty.get_incident`,
 *    `pagerduty.list_log_entries` — **read_only**. Fixed call plan, one page,
 *    bounded and redacted results, server-side only.
 *  - `pagerduty.acknowledge`, `pagerduty.resolve` — **scoped_write** per the
 *    wave-16 brief. They require a separate `incidents.write` credential and a
 *    `From` address, audit every outcome through the injected callback and can
 *    change only `status` on one incident. `docs/connectors/pagerduty.md`
 *    classifies paging-state changes as `sensitive`; the registration policy may
 *    apply that stricter band without touching this module.
 *
 * There is no policy edit here, no snooze, no note/responder field and no tool
 * that accepts a provider URL. Results never contain the token, `From` address,
 * responder names, emails, phone numbers, contact methods or raw log bodies.
 */

export const PAGERDUTY_LIST_INCIDENTS_TOOL = "pagerduty.list_incidents";
export const PAGERDUTY_GET_INCIDENT_TOOL = "pagerduty.get_incident";
export const PAGERDUTY_LIST_LOG_ENTRIES_TOOL = "pagerduty.list_log_entries";
export const PAGERDUTY_ACKNOWLEDGE_TOOL = "pagerduty.acknowledge";
export const PAGERDUTY_RESOLVE_TOOL = "pagerduty.resolve";

export const PAGERDUTY_TOOL_RISK_BANDS = {
	[PAGERDUTY_LIST_INCIDENTS_TOOL]: "read_only",
	[PAGERDUTY_GET_INCIDENT_TOOL]: "read_only",
	[PAGERDUTY_LIST_LOG_ENTRIES_TOOL]: "read_only",
	[PAGERDUTY_ACKNOWLEDGE_TOOL]: "scoped_write",
	[PAGERDUTY_RESOLVE_TOOL]: "scoped_write",
} as const;

export type PagerDutyToolName = keyof typeof PAGERDUTY_TOOL_RISK_BANDS;
export type PagerDutyReadToolName =
	| typeof PAGERDUTY_LIST_INCIDENTS_TOOL
	| typeof PAGERDUTY_GET_INCIDENT_TOOL
	| typeof PAGERDUTY_LIST_LOG_ENTRIES_TOOL;
export type PagerDutyToolRiskBand =
	(typeof PAGERDUTY_TOOL_RISK_BANDS)[PagerDutyToolName];

export const PAGERDUTY_TOOL_MAX_INCIDENTS = 25;
export const PAGERDUTY_TOOL_MAX_LOG_ENTRIES = 20;
const MAX_RESULT_TITLE_CHARS = 200;
const MAX_RESULT_NAME_CHARS = 128;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

const incidentIdSchema = z
	.string()
	.regex(PAGERDUTY_RESOURCE_ID_PATTERN, "invalid pagerduty incident id");

export const pagerDutyListIncidentsInputSchema = z
	.object({
		status: pagerDutyIncidentStatusSchema.optional(),
		serviceId: z.string().regex(PAGERDUTY_RESOURCE_ID_PATTERN).optional(),
		limit: z.number().int().min(1).max(PAGERDUTY_TOOL_MAX_INCIDENTS).optional(),
	})
	.strict();

export const pagerDutyGetIncidentInputSchema = z
	.object({ incidentId: incidentIdSchema })
	.strict();

export const pagerDutyListLogEntriesInputSchema = z
	.object({
		incidentId: incidentIdSchema,
		limit: z
			.number()
			.int()
			.min(1)
			.max(PAGERDUTY_TOOL_MAX_LOG_ENTRIES)
			.optional(),
	})
	.strict();

export type PagerDutyListIncidentsInput = z.input<
	typeof pagerDutyListIncidentsInputSchema
>;
export type PagerDutyGetIncidentInput = z.input<
	typeof pagerDutyGetIncidentInputSchema
>;
export type PagerDutyListLogEntriesInput = z.input<
	typeof pagerDutyListLogEntriesInputSchema
>;

export type PagerDutyToolDependencies = {
	token: string;
	baseUrl?: string;
	fromEmail?: string;
	fetchImpl?: PagerDutyFetch;
	now?: () => number;
	timeoutMs?: number;
};

export const pagerDutyWriteInputSchema = z
	.object({ incidentId: incidentIdSchema })
	.strict();

export type PagerDutyWriteFailureCode =
	| "VALIDATION_FAILED"
	| "POLICY_DENIED"
	| "NOT_FOUND"
	| "RATE_LIMITED"
	| "INTEGRATION_UNAVAILABLE";

export type PagerDutyWriteResult =
	| { ok: true; incidentId: string; status: "acknowledged" | "resolved" }
	| { ok: false; code: PagerDutyWriteFailureCode; message: string };

/** One audit entry per write attempt; never carries a token, address or body. */
export type PagerDutyWriteAuditEntry = {
	tool: typeof PAGERDUTY_ACKNOWLEDGE_TOOL | typeof PAGERDUTY_RESOLVE_TOOL;
	risk: "scoped_write";
	outcome: "SUCCEEDED" | "FAILED" | "BLOCKED";
	incidentId: string;
	code?: PagerDutyWriteFailureCode;
	organizationId?: string;
	taskId?: string;
};

export type PagerDutyWriteDependencies = {
	/** Separate `incidents.write` credential; never the read token. */
	token: string;
	/** Valid PagerDuty user address; required by the write API. */
	fromEmail: string;
	audit: (
		entry: PagerDutyWriteAuditEntry,
		// biome-ignore lint/suspicious/noConfusingVoidType: sync and async sinks both assign
	) => void | Promise<unknown>;
	baseUrl?: string;
	fetchImpl?: PagerDutyFetch;
	timeoutMs?: number;
	organizationId?: string;
	taskId?: string;
};

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function bound(text: string, maxChars: number): string {
	return text.length <= maxChars
		? text
		: `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function safeUrl(value: string | undefined): string | undefined {
	return value !== undefined && isBoundedHttpsUrl(value) ? value : undefined;
}

function toBoundedIncident(
	incident: PagerDutyIncident,
	secrets: readonly string[],
): Record<string, unknown> {
	const redact = (text: string): string => redactPagerDutyText(text, secrets);
	const serviceName = nonEmpty(incident.service.name) ?? incident.service.id;
	const priorityName = nonEmpty(incident.priority?.name);
	const url = safeUrl(incident.html_url);
	return {
		id: incident.id,
		...(incident.number === undefined ? {} : { number: incident.number }),
		title: bound(redact(incident.title), MAX_RESULT_TITLE_CHARS),
		status: incident.status,
		...(incident.urgency === undefined ? {} : { urgency: incident.urgency }),
		...(priorityName === null
			? {}
			: { priority: bound(redact(priorityName), 64) }),
		service: {
			id: incident.service.id,
			name: bound(redact(serviceName), MAX_RESULT_NAME_CHARS),
		},
		...(incident.created_at === undefined
			? {}
			: { createdAt: incident.created_at }),
		...(incident.updated_at === undefined
			? {}
			: { updatedAt: incident.updated_at }),
		...(url === undefined ? {} : { url }),
	};
}

function failure(
	code: PagerDutyWriteFailureCode,
	message: string,
): PagerDutyWriteResult {
	return { ok: false, code, message };
}

function isResourceId(value: unknown): value is string {
	return typeof value === "string" && PAGERDUTY_RESOURCE_ID_PATTERN.test(value);
}

function quietAudit(
	dependencies: PagerDutyWriteDependencies,
	entry: Omit<PagerDutyWriteAuditEntry, "organizationId" | "taskId">,
): void {
	// A broken sink never changes the connector result.
	void Promise.resolve()
		.then(() =>
			dependencies.audit({
				...entry,
				...(dependencies.organizationId === undefined
					? {}
					: { organizationId: dependencies.organizationId }),
				...(dependencies.taskId === undefined
					? {}
					: { taskId: dependencies.taskId }),
			}),
		)
		.catch(() => undefined);
}

function readCaller(dependencies: PagerDutyToolDependencies, maxCalls: number) {
	return createPagerDutyReadCaller({
		token: dependencies.token,
		...(dependencies.baseUrl === undefined
			? {}
			: { baseUrl: dependencies.baseUrl }),
		...(dependencies.fromEmail === undefined
			? {}
			: { fromEmail: dependencies.fromEmail }),
		...(dependencies.fetchImpl === undefined
			? {}
			: { fetchImpl: dependencies.fetchImpl }),
		...(dependencies.timeoutMs === undefined
			? {}
			: { timeoutMs: dependencies.timeoutMs }),
		maxCalls,
	});
}

function unwrapReadResult(
	result: PagerDutyCallResult,
	step: string,
): { body: unknown } {
	if (result.kind === "ok") return { body: result.body };
	if (result.kind === "missing") {
		throw new PlatformError("NOT_FOUND", `${step} was not found`);
	}
	if (result.kind === "denied") {
		throw new PlatformError("POLICY_DENIED", `${step} access was denied`);
	}
	throw new PlatformError(
		"INTEGRATION_UNAVAILABLE",
		`${step} returned an unusable response`,
	);
}

async function listIncidents(
	dependencies: PagerDutyToolDependencies,
	args: unknown,
): Promise<Record<string, unknown>> {
	const parsed = pagerDutyListIncidentsInputSchema.safeParse(args);
	if (!parsed.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"pagerduty.list_incidents requires optional status, serviceId and limit 1-25",
		);
	}
	const input = parsed.data;
	const limit = input.limit ?? 10;
	const params = new URLSearchParams();
	params.set("limit", String(limit));
	params.append("include[]", "services");
	if (input.status !== undefined) params.append("statuses[]", input.status);
	if (input.serviceId !== undefined) {
		params.append("service_ids[]", input.serviceId);
	}

	const caller = readCaller(dependencies, 1);
	const result = unwrapReadResult(
		await caller.call(
			`/incidents?${params.toString()}`,
			"pagerduty incident list",
		),
		"pagerduty incident list",
	);
	const parsedResponse = pagerDutyIncidentListResponseSchema.safeParse(
		result.body,
	);
	if (!parsedResponse.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"pagerduty incident list returned an unexpected response shape",
		);
	}
	const secrets = [
		dependencies.token,
		...(dependencies.fromEmail === undefined ? [] : [dependencies.fromEmail]),
	];
	return {
		incidents: parsedResponse.data.incidents
			.slice(0, limit)
			.map((incident) => toBoundedIncident(incident, secrets)),
	};
}

async function getIncident(
	dependencies: PagerDutyToolDependencies,
	args: unknown,
): Promise<Record<string, unknown>> {
	const parsed = pagerDutyGetIncidentInputSchema.safeParse(args);
	if (!parsed.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"pagerduty.get_incident requires a pagerduty incident id",
		);
	}
	const caller = readCaller(dependencies, 1);
	const result = unwrapReadResult(
		await caller.call(
			`/incidents/${encodeURIComponent(parsed.data.incidentId)}?include%5B%5D=services&include%5B%5D=priorities`,
			"pagerduty incident",
		),
		"pagerduty incident",
	);
	const parsedResponse = pagerDutyIncidentResponseSchema.safeParse(result.body);
	if (!parsedResponse.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"pagerduty incident returned an unexpected response shape",
		);
	}
	const secrets = [
		dependencies.token,
		...(dependencies.fromEmail === undefined ? [] : [dependencies.fromEmail]),
	];
	return {
		incident: toBoundedIncident(parsedResponse.data.incident, secrets),
	};
}

async function listLogEntries(
	dependencies: PagerDutyToolDependencies,
	args: unknown,
): Promise<Record<string, unknown>> {
	const parsed = pagerDutyListLogEntriesInputSchema.safeParse(args);
	if (!parsed.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"pagerduty.list_log_entries requires a pagerduty incident id and limit 1-20",
		);
	}
	const input = parsed.data;
	const limit = input.limit ?? PAGERDUTY_TOOL_MAX_LOG_ENTRIES;
	const caller = readCaller(dependencies, 1);
	const result = unwrapReadResult(
		await caller.call(
			`/incidents/${encodeURIComponent(input.incidentId)}/log_entries?limit=${limit}&is_overview=true`,
			"pagerduty incident log entries",
		),
		"pagerduty incident log entries",
	);
	const parsedResponse = pagerDutyLogEntriesResponseSchema.safeParse(
		result.body,
	);
	if (!parsedResponse.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"pagerduty log entries returned an unexpected response shape",
		);
	}
	const secrets = [
		dependencies.token,
		...(dependencies.fromEmail === undefined ? [] : [dependencies.fromEmail]),
	];
	return {
		entries: parsedResponse.data.log_entries.slice(0, limit).map((entry) => ({
			id: entry.id,
			type: bound(redactPagerDutyText(entry.type, secrets), 64),
			createdAt: entry.created_at,
			actorRole: bound(
				redactPagerDutyText(nonEmpty(entry.agent?.type) ?? "unknown", secrets),
				64,
			),
		})),
	};
}

export type PagerDutyReadTool = {
	name: PagerDutyReadToolName;
	risk: "read_only";
	inputSchema: z.ZodType<unknown>;
	execute(args: unknown): Promise<Record<string, unknown>>;
};

/** Builds the three read-only descriptors; nothing here is sandbox-callable. */
export function createPagerDutyReadTools(
	dependencies: PagerDutyToolDependencies,
): readonly PagerDutyReadTool[] {
	return [
		{
			name: PAGERDUTY_LIST_INCIDENTS_TOOL,
			risk: "read_only",
			inputSchema: pagerDutyListIncidentsInputSchema,
			execute: (args) => listIncidents(dependencies, args),
		},
		{
			name: PAGERDUTY_GET_INCIDENT_TOOL,
			risk: "read_only",
			inputSchema: pagerDutyGetIncidentInputSchema,
			execute: (args) => getIncident(dependencies, args),
		},
		{
			name: PAGERDUTY_LIST_LOG_ENTRIES_TOOL,
			risk: "read_only",
			inputSchema: pagerDutyListLogEntriesInputSchema,
			execute: (args) => listLogEntries(dependencies, args),
		},
	];
}

/** Exported for direct server-side use; equivalent to the descriptor execute. */
export const pagerDutyReadFunctions = {
	listIncidents,
	getIncident,
	listLogEntries,
} as const;

function mapWriteStatus(status: number): PagerDutyWriteFailureCode {
	if (status === 401 || status >= 500) return "INTEGRATION_UNAVAILABLE";
	if (status === 403) return "POLICY_DENIED";
	if (status === 404) return "NOT_FOUND";
	if (status === 429) return "RATE_LIMITED";
	return "POLICY_DENIED";
}

function writeMessage(
	tool: typeof PAGERDUTY_ACKNOWLEDGE_TOOL | typeof PAGERDUTY_RESOLVE_TOOL,
	code: PagerDutyWriteFailureCode,
): string {
	const action =
		tool === PAGERDUTY_ACKNOWLEDGE_TOOL ? "acknowledge" : "resolve";
	switch (code) {
		case "NOT_FOUND":
			return `pagerduty incident could not be found to ${action}`;
		case "POLICY_DENIED":
			return `pagerduty denied permission to ${action} the incident`;
		case "RATE_LIMITED":
			return `pagerduty rate limited the ${action} request`;
		case "VALIDATION_FAILED":
			return `pagerduty ${action} input was invalid`;
		default:
			return `pagerduty ${action} request failed`;
	}
}

async function updateIncident(
	dependencies: PagerDutyWriteDependencies,
	args: unknown,
	status: "acknowledged" | "resolved",
	tool: typeof PAGERDUTY_ACKNOWLEDGE_TOOL | typeof PAGERDUTY_RESOLVE_TOOL,
): Promise<PagerDutyWriteResult> {
	const parsed = pagerDutyWriteInputSchema.safeParse(args);
	if (!parsed.success) {
		const rawId = (args as { incidentId?: unknown } | null)?.incidentId;
		quietAudit(dependencies, {
			tool,
			risk: "scoped_write",
			outcome: "BLOCKED",
			incidentId: isResourceId(rawId) ? rawId : "unknown",
			code: "VALIDATION_FAILED",
		});
		return failure(
			"VALIDATION_FAILED",
			`pagerduty ${status === "acknowledged" ? "acknowledge" : "resolve"} requires one pagerduty incident id`,
		);
	}
	const incidentId = parsed.data.incidentId;

	let token: string;
	let fromEmail: string;
	let baseUrl: string;
	try {
		token = requirePagerDutyWriteToken(dependencies.token);
		fromEmail = requirePagerDutyFromEmail(dependencies.fromEmail);
		baseUrl = normalizePagerDutyBaseUrl(dependencies.baseUrl);
	} catch (throwable) {
		const code: PagerDutyWriteFailureCode =
			throwable instanceof PlatformError &&
			throwable.code === "VALIDATION_FAILED"
				? "VALIDATION_FAILED"
				: "INTEGRATION_UNAVAILABLE";
		quietAudit(dependencies, {
			tool,
			risk: "scoped_write",
			outcome: "BLOCKED",
			incidentId,
			code,
		});
		return failure(code, writeMessage(tool, code));
	}

	const fetchImpl =
		dependencies.fetchImpl ?? ((request, init) => fetch(request, init));
	const timeoutMs = Math.min(
		Math.max(1, Math.floor(dependencies.timeoutMs ?? 10_000)),
		30_000,
	);
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}/incidents`, {
			method: "PUT",
			headers: {
				Accept: PAGERDUTY_ACCEPT,
				"Content-Type": "application/json",
				"User-Agent": PAGERDUTY_USER_AGENT,
				Authorization: `Token token=${token}`,
				From: fromEmail,
			},
			body: JSON.stringify({
				incidents: [{ id: incidentId, type: "incident_reference", status }],
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch {
		quietAudit(dependencies, {
			tool,
			risk: "scoped_write",
			outcome: "FAILED",
			incidentId,
			code: "INTEGRATION_UNAVAILABLE",
		});
		return failure(
			"INTEGRATION_UNAVAILABLE",
			writeMessage(tool, "INTEGRATION_UNAVAILABLE"),
		);
	}

	let bodyText = "";
	try {
		bodyText = await response.text();
	} catch {
		bodyText = "";
	}
	const boundedBody =
		new TextEncoder().encode(bodyText).byteLength <= MAX_ERROR_RESPONSE_BYTES;

	if (response.status !== 200) {
		const code = mapWriteStatus(response.status);
		quietAudit(dependencies, {
			tool,
			risk: "scoped_write",
			outcome: "FAILED",
			incidentId,
			code,
		});
		return failure(code, writeMessage(tool, code));
	}

	let parsedBody: unknown;
	try {
		parsedBody = boundedBody ? JSON.parse(bodyText) : undefined;
	} catch {
		parsedBody = undefined;
	}
	const parsedResponse =
		pagerDutyIncidentWriteResponseSchema.safeParse(parsedBody);
	const written =
		parsedResponse.success === true
			? (parsedResponse.data.incidents?.[0] ?? parsedResponse.data.incident)
			: undefined;
	if (
		written === undefined ||
		written.id !== incidentId ||
		written.status !== status
	) {
		quietAudit(dependencies, {
			tool,
			risk: "scoped_write",
			outcome: "FAILED",
			incidentId,
			code: "INTEGRATION_UNAVAILABLE",
		});
		return failure(
			"INTEGRATION_UNAVAILABLE",
			writeMessage(tool, "INTEGRATION_UNAVAILABLE"),
		);
	}

	quietAudit(dependencies, {
		tool,
		risk: "scoped_write",
		outcome: "SUCCEEDED",
		incidentId,
	});
	return { ok: true, incidentId, status };
}

/**
 * `scoped_write`: acknowledges one incident (`PUT /incidents`). Requires a
 * separate `incidents.write` credential and a valid `From` address; audited
 * through the injected callback with no token, address or provider text.
 */
export function acknowledgePagerDutyIncident(
	dependencies: PagerDutyWriteDependencies,
	input: unknown,
): Promise<PagerDutyWriteResult> {
	return updateIncident(
		dependencies,
		input,
		"acknowledged",
		PAGERDUTY_ACKNOWLEDGE_TOOL,
	);
}

/**
 * `scoped_write`: resolves one incident. Resolution is an incident-owner
 * decision, never a test outcome; approval policy is applied by the registry,
 * not here.
 */
export function resolvePagerDutyIncident(
	dependencies: PagerDutyWriteDependencies,
	input: unknown,
): Promise<PagerDutyWriteResult> {
	return updateIncident(
		dependencies,
		input,
		"resolved",
		PAGERDUTY_RESOLVE_TOOL,
	);
}
