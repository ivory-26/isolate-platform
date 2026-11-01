import { z } from "zod";

/**
 * Bounded wire contracts between the daemon and
 * `apps/web/src/server/device-gateway.server.ts`.
 *
 * The claim payload is stored server-side and already normalized there, but the
 * daemon re-validates it: a compromised or misconfigured gateway must not be
 * able to make the daemon execute an arbitrary tool or an oversized parameter
 * object. Results are `{ ok: true, data }` or `{ ok: false, errorCode }` with
 * the gateway's closed error-code set.
 */

export const DEVICE_ERROR_CODES = [
	"INTEGRATION_UNAVAILABLE",
	"RATE_LIMITED",
	"POLICY_DENIED",
	"VALIDATION_FAILED",
	"NOT_FOUND",
	"INTERNAL",
] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];

/** Server caps the result at 16 KiB; the daemon never sends more. */
export const DEVICE_MAX_RESULT_BYTES = 16 * 1024;
export const DEVICE_MAX_PARAMS_BYTES = 16 * 1024;
export const DEVICE_CALL_MAX_PARAM_KEYS = 64;

const CALL_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const deviceCallSchema = z.strictObject({
	id: z.string().regex(CALL_ID_PATTERN, "invalid call id"),
	connectorId: z.string().regex(CONNECTOR_ID_PATTERN, "invalid connector id"),
	credentialRef: z.string().min(1).max(200),
	toolName: z.string().min(1).max(64),
	params: z
		.record(z.string().min(1).max(64), z.unknown())
		.refine(
			(value) => Object.keys(value).length <= DEVICE_CALL_MAX_PARAM_KEYS,
			"too many params",
		)
		.default({}),
	deadlineAt: z.iso.datetime({ offset: true }),
});

export type DeviceCall = z.output<typeof deviceCallSchema>;

/**
 * A claim round answers either the single-call envelope `{ call }` (no
 * `?limit=`, or `?limit=1`) or the batch envelope `{ calls }`. Both are closed
 * objects: a mixed body, an extra key or more than ten calls is invalid.
 */
export const DEVICE_MAX_CLAIM_BATCH = 10;

export const claimResponseSchema = z.union([
	z.strictObject({ call: deviceCallSchema.nullable() }),
	z.strictObject({
		calls: z.array(deviceCallSchema).max(DEVICE_MAX_CLAIM_BATCH),
	}),
]);

export type ClaimResponse = z.output<typeof claimResponseSchema>;

/** Flattens either envelope into an ordered, possibly empty, call list. */
export function claimedCalls(response: ClaimResponse): DeviceCall[] {
	if ("calls" in response) return response.calls;
	return response.call === null ? [] : [response.call];
}

export type ToolParams = Record<string, unknown>;

export type DispatchSuccess = {
	readonly ok: true;
	readonly data: Record<string, unknown>;
};

export type DispatchFailure = {
	readonly ok: false;
	readonly errorCode: DeviceErrorCode;
};

export type DispatchOutcome = DispatchSuccess | DispatchFailure;

export type ToolHandler = (params: ToolParams) => Promise<DispatchOutcome>;

export type DeviceDispatcher = (call: DeviceCall) => Promise<DispatchOutcome>;

/** JSON byte length of a candidate result body (for the 16 KiB cap). */
export function jsonByteLength(value: unknown): number {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		return Number.POSITIVE_INFINITY;
	}
	if (text === undefined) return Number.POSITIVE_INFINITY;
	return new TextEncoder().encode(text).byteLength;
}
