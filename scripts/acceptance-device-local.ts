import { strict as assert } from "node:assert";
import {
	createDb,
	PostgresConnectorCallRepository,
} from "../packages/db/src/index";
import { asOrganizationId } from "../packages/shared/src/index";

/**
 * End-to-end local device acceptance (queue + daemon + local provider).
 *
 * The daemon must be running and polling `/api/device/claim` with the same
 * database. This script enqueues one bounded call and waits for the device's
 * result; it holds no provider key.
 *
 * Required env (names only):
 *   LIVE_DEVICE=1, DATABASE_URL, DEVICE_ORGANIZATION_ID, DEVICE_ID,
 *   DEVICE_CREDENTIAL_ID, DEVICE_CONNECTOR_ID, DEVICE_TOOL_NAME,
 *   DEVICE_PARAMS_JSON (optional task id / await timeout).
 */

if (process.env.LIVE_DEVICE !== "1") {
	console.log("Set LIVE_DEVICE=1 to run the local device acceptance.");
	process.exit(0);
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		console.error(`${name} is required for this acceptance run`);
		process.exit(1);
	}
	return value;
}

const databaseUrl = required("DATABASE_URL");
const organizationId = asOrganizationId(required("DEVICE_ORGANIZATION_ID"));
const deviceId = required("DEVICE_ID");
const credentialId = required("DEVICE_CREDENTIAL_ID");
const connectorId = required("DEVICE_CONNECTOR_ID");
const toolName = required("DEVICE_TOOL_NAME");
const awaitTimeoutMs = Number(process.env.DEVICE_AWAIT_MS?.trim() || "120000");
const taskId = process.env.DEVICE_TASK_ID?.trim() || null;

let params: Record<string, unknown> = {};
const rawParams = process.env.DEVICE_PARAMS_JSON?.trim();
if (rawParams) {
	try {
		const parsed: unknown = JSON.parse(rawParams);
		assert.ok(
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
			"DEVICE_PARAMS_JSON must be a JSON object",
		);
		params = parsed as Record<string, unknown>;
	} catch (error) {
		console.error(
			`DEVICE_PARAMS_JSON is invalid: ${error instanceof Error ? error.message : "parse error"}`,
		);
		process.exit(1);
	}
}

assert.ok(Number.isSafeInteger(awaitTimeoutMs) && awaitTimeoutMs > 0);

const sql = createDb(databaseUrl);
try {
	const calls = new PostgresConnectorCallRepository(sql);
	const call = await calls.enqueue({
		organizationId,
		deviceId,
		credentialId,
		taskId,
		connectorId,
		toolName,
		params,
		ttlMs: awaitTimeoutMs + 30_000,
	});
	console.log(`enqueued call ${call.id} (${connectorId}/${toolName})`);

	const outcome = await calls.awaitResult(call.id, awaitTimeoutMs, 1000);
	if (outcome === null) {
		console.error("DEVICE ACCEPTANCE FAILED: no result before the timeout");
		process.exit(1);
	}
	if (!outcome.ok) {
		console.error(`DEVICE ACCEPTANCE FAILED: ${outcome.errorCode}`);
		process.exit(1);
	}
	const data = JSON.stringify(outcome.data);
	console.log(`device result: ${data.length} bytes`);
	console.log(`preview: ${data.slice(0, 240)}`);
	console.log("LOCAL DEVICE ACCEPTANCE PASSED");
} finally {
	await sql.end({ timeout: 5 });
}
