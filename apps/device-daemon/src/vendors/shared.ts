import { isPlatformError } from "@isolate/shared";
import {
	DEVICE_MAX_RESULT_BYTES,
	type DeviceErrorCode,
	type DispatchOutcome,
	jsonByteLength,
} from "../contracts";

/**
 * Adapter result normalization shared by every vendor module.
 *
 * The ten adapters return slightly different success/failure envelopes
 * (`{ ok, data }`, `{ ok, tool, item }`, a bare `{ incidents }`, or a thrown
 * `PlatformError`). The daemon converts all of them to the gateway's two-key
 * result envelope and a closed error code. Provider text and secrets are never
 * propagated: only the code survives.
 */

const ADAPTER_CODE_MAP: Readonly<Record<string, DeviceErrorCode>> = {
	VALIDATION_FAILED: "VALIDATION_FAILED",
	NOT_FOUND: "NOT_FOUND",
	POLICY_DENIED: "POLICY_DENIED",
	RATE_LIMITED: "RATE_LIMITED",
	INTEGRATION_UNAVAILABLE: "INTEGRATION_UNAVAILABLE",
	MISSING_CONFIG: "INTEGRATION_UNAVAILABLE",
	INTERNAL: "INTERNAL",
};

export function failure(errorCode: DeviceErrorCode): DispatchOutcome {
	return { ok: false, errorCode };
}

export function mapAdapterErrorCode(code: unknown): DeviceErrorCode {
	if (typeof code !== "string") return "INTERNAL";
	return ADAPTER_CODE_MAP[code] ?? "INTERNAL";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * The gateway requires `data` to be a JSON object, so an adapter array is
 * wrapped as `{ items }` and a scalar as `{ value }`. Absent evidence stays
 * `null` nested inside the object; it is never flattened into an empty object.
 */
function objectify(data: unknown): Record<string, unknown> {
	if (Array.isArray(data)) return { items: data };
	if (isPlainObject(data)) return data;
	return { value: data ?? null };
}

/** Wraps a trusted adapter success, enforcing the server's 256 KiB result cap. */
export function boundedSuccess(value: unknown): DispatchOutcome {
	const data = objectify(value);
	if (jsonByteLength(data) > DEVICE_MAX_RESULT_BYTES) {
		return failure("VALIDATION_FAILED");
	}
	return { ok: true, data };
}

function normalizeAdapterResult(result: unknown): DispatchOutcome {
	if (!isPlainObject(result)) return boundedSuccess(result);
	if (result.ok === true) {
		return boundedSuccess("data" in result ? result.data : result);
	}
	if (result.ok === false) {
		const code = "errorCode" in result ? result.errorCode : result.code;
		return failure(mapAdapterErrorCode(code));
	}
	return boundedSuccess(result);
}

/** Runs one adapter call and maps every outcome to a fixed envelope. */
export async function runAdapter(
	run: () => Promise<unknown>,
): Promise<DispatchOutcome> {
	try {
		return normalizeAdapterResult(await run());
	} catch (error) {
		if (isPlatformError(error)) {
			return failure(mapAdapterErrorCode(error.code));
		}
		return failure("INTERNAL");
	}
}

/** Fails closed when a vendor dependency cannot be built from config/env. */
export async function withDependencies<T>(
	dependencies: T | null,
	run: (dependencies: T) => Promise<unknown>,
): Promise<DispatchOutcome> {
	if (dependencies === null) return failure("INTEGRATION_UNAVAILABLE");
	return runAdapter(() => run(dependencies));
}
