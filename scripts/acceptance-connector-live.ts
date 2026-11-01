import {
	CONNECTOR_CALL_MAX_AWAIT_TIMEOUT_MS,
	CONNECTOR_CALL_MAX_TTL_MS,
	createDb,
	PostgresConnectorCallRepository,
} from "../packages/db/src/index";
import {
	asOrganizationId,
	connectorIdSchema,
} from "../packages/shared/src/index";

/**
 * Device-path live acceptance for the five remaining SaaS connectors
 * (Datadog, New Relic, Honeycomb, Axiom, SigNoz — plus any already-bound one).
 *
 * The script enqueues ONE connector call through the same
 * `PostgresConnectorCallRepository` the worker connector tools use, then waits
 * for the device daemon to claim it, execute it on the device and post the
 * bounded result. It holds no provider credential: the provider key stays in
 * the device keychain and the server only ever sees typed arguments and a
 * bounded result.
 *
 * Required env (names only; values stay in the process environment):
 *   CONNECTOR_LIVE=1
 *   CONNECTOR_LIVE_VENDOR        connector id, e.g. datadog / new-relic
 *   DATABASE_URL
 *   DEVICE_ORGANIZATION_ID
 *   DEVICE_ID
 *   DEVICE_CREDENTIAL_ID
 *   CONNECTOR_TOOL_NAME
 * Optional:
 *   CONNECTOR_TOOL_PARAMS_JSON   JSON object of typed tool arguments
 *   CONNECTOR_AWAIT_MS           result wait budget (default 60000, max 60000)
 *
 * The daemon must be running and polling `/api/device/claim` for the same
 * device and database. Exactly one call is enqueued; there are no retries.
 */

const CONNECTOR_LIVE_VENDORS = [
	"datadog",
	"new-relic",
	"honeycomb",
	"axiom",
	"signoz",
] as const;
const DEFAULT_AWAIT_MS = 60_000;
const MAX_PREVIEW_CHARS = 240;
const MAX_ERROR_CHARS = 240;

if (process.env.CONNECTOR_LIVE !== "1") {
	console.log("Connector live acceptance is opt-in and never runs by default.");
	console.log("");
	console.log("Set CONNECTOR_LIVE=1 plus these names for one bounded run:");
	console.log(
		"  CONNECTOR_LIVE_VENDOR, DATABASE_URL, DEVICE_ORGANIZATION_ID, DEVICE_ID,",
	);
	console.log(
		"  DEVICE_CREDENTIAL_ID, CONNECTOR_TOOL_NAME, CONNECTOR_TOOL_PARAMS_JSON (optional),",
	);
	console.log("  CONNECTOR_AWAIT_MS (optional)");
	console.log("");
	console.log(`Supported vendors: ${CONNECTOR_LIVE_VENDORS.join(", ")}`);
	console.log("");
	console.log("Example (provider key stays in the device keychain):");
	console.log(
		'  CONNECTOR_LIVE=1 CONNECTOR_LIVE_VENDOR=datadog CONNECTOR_TOOL_NAME=incident_context CONNECTOR_TOOL_PARAMS_JSON=\'{"incidentId":"<id>"}\' bun run acceptance:connector-live',
	);
	process.exit(0);
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for this acceptance run`);
	return value;
}

function boundedError(error: unknown): string {
	const message = error instanceof Error ? error.message : "unknown error";
	return message.length > MAX_ERROR_CHARS
		? `${message.slice(0, MAX_ERROR_CHARS - 1)}…`
		: message;
}

function readParams(): Record<string, unknown> {
	const raw = process.env.CONNECTOR_TOOL_PARAMS_JSON?.trim();
	if (!raw) return {};
	const parsed: unknown = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("CONNECTOR_TOOL_PARAMS_JSON must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function readAwaitMs(): number {
	const raw = process.env.CONNECTOR_AWAIT_MS?.trim();
	if (!raw) return DEFAULT_AWAIT_MS;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error("CONNECTOR_AWAIT_MS must be a positive integer");
	}
	return Math.min(CONNECTOR_CALL_MAX_AWAIT_TIMEOUT_MS, value);
}

async function run(): Promise<number> {
	const vendor = required("CONNECTOR_LIVE_VENDOR");
	const connectorId = connectorIdSchema.safeParse(vendor);
	if (!connectorId.success) {
		throw new Error("CONNECTOR_LIVE_VENDOR must be a lowercase connector id");
	}
	const databaseUrl = required("DATABASE_URL");
	const organizationId = asOrganizationId(required("DEVICE_ORGANIZATION_ID"));
	const deviceId = required("DEVICE_ID");
	const credentialId = required("DEVICE_CREDENTIAL_ID");
	const toolName = required("CONNECTOR_TOOL_NAME");
	const params = readParams();
	const awaitMs = readAwaitMs();
	// The row must outlive the wait, and the repository caps TTL at 15 minutes.
	const ttlMs = Math.min(CONNECTOR_CALL_MAX_TTL_MS, awaitMs + 30_000);

	const sql = createDb(databaseUrl);
	try {
		const calls = new PostgresConnectorCallRepository(sql);
		const call = await calls.enqueue({
			organizationId,
			deviceId,
			credentialId,
			taskId: null,
			connectorId: connectorId.data,
			toolName,
			params,
			ttlMs,
		});
		console.log(`enqueued call ${call.id} (${connectorId.data}/${toolName})`);

		const outcome = await calls.awaitResult(call.id, awaitMs, 1_000, {
			organizationId,
			deviceId,
		});
		if (outcome === null) {
			console.error(
				"CONNECTOR LIVE ACCEPTANCE FAILED: no result before the timeout",
			);
			return 1;
		}
		if (!outcome.ok) {
			console.error(`CONNECTOR LIVE ACCEPTANCE FAILED: ${outcome.errorCode}`);
			return 1;
		}
		const serialized = JSON.stringify(outcome.data);
		console.log(`result keys: ${Object.keys(outcome.data).length}`);
		console.log(`result bytes: ${Buffer.byteLength(serialized, "utf8")}`);
		console.log(`preview: ${serialized.slice(0, MAX_PREVIEW_CHARS)}`);
		console.log(
			`CONNECTOR LIVE ACCEPTANCE PASSED (${connectorId.data}/${toolName})`,
		);
		return 0;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

try {
	process.exitCode = await run();
} catch (error) {
	console.error(`CONNECTOR LIVE ACCEPTANCE FAILED: ${boundedError(error)}`);
	process.exitCode = 1;
}
