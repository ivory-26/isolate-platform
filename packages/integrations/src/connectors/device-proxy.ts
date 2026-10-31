import {
	connectorCredentialRefSchema,
	connectorIdSchema,
	type OrganizationId,
	PlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import { z } from "zod";

/**
 * Device proxy: the only path from the platform to a provider.
 *
 * The server never holds a provider secret. It sends a bounded, typed request
 * to the registered device endpoint; the device looks up its own keychain item
 * by `credentialRef`, calls the provider and returns a bounded `{ ok, data }`.
 * The transport is injected (`DeviceProxyFactory`), so the platform can ship
 * offline with `NullDeviceProxy` and add a WebSocket/HTTP bridge later without
 * changing this contract.
 *
 * Failure results are `{ ok: false, error: { code, message } }` with fixed,
 * credential-free messages: provider text never crosses this boundary.
 */

export const DEVICE_PROXY_DEFAULT_TIMEOUT_MS = 10_000;
export const DEVICE_PROXY_MIN_TIMEOUT_MS = 250;
export const DEVICE_PROXY_MAX_TIMEOUT_MS = 30_000;
export const DEVICE_PROXY_MAX_PARAMS_BYTES = 16 * 1024;
export const DEVICE_PROXY_MAX_RESPONSE_BYTES = 16 * 1024;
export const MAX_DEVICE_PROXY_OPERATION_CHARS = 64;
export const MAX_DEVICE_PROXY_PARAM_KEYS = 64;
export const MAX_DEVICE_PROXY_ARRAY_ITEMS = 256;
export const MAX_DEVICE_PROXY_DEPTH = 5;

const OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const DEVICE_PROXY_ERROR_CODES = [
	"INTEGRATION_UNAVAILABLE",
	"RATE_LIMITED",
	"POLICY_DENIED",
	"VALIDATION_FAILED",
	"NOT_FOUND",
	"INTERNAL",
] as const;
export type DeviceProxyErrorCode = (typeof DEVICE_PROXY_ERROR_CODES)[number];

const FAILURE_MESSAGES: Record<DeviceProxyErrorCode, string> = {
	INTEGRATION_UNAVAILABLE: "connector device is unavailable",
	RATE_LIMITED: "connector device is rate limited",
	POLICY_DENIED: "connector device call was denied",
	VALIDATION_FAILED: "connector device response was invalid",
	NOT_FOUND: "connector device target was not found",
	INTERNAL: "connector device call failed",
};

export type DeviceProxyFailure = {
	readonly ok: false;
	readonly error: {
		readonly code: DeviceProxyErrorCode;
		readonly message: string;
	};
};

export type DeviceProxySuccess = {
	readonly ok: true;
	readonly data: unknown;
};

export type DeviceProxyResult = DeviceProxySuccess | DeviceProxyFailure;

export type ConnectorDeviceProxyRequest = {
	readonly connectorId: string;
	readonly credentialRef: string;
	/** Fixed operation name from a closed per-connector vocabulary. */
	readonly operation: string;
	/** Bounded JSON arguments; never a URL, secret or provider header. */
	readonly params?: Readonly<Record<string, unknown>>;
	readonly timeoutMs?: number;
};

export type NormalizedConnectorDeviceProxyRequest = {
	readonly connectorId: string;
	readonly credentialRef: string;
	readonly operation: string;
	readonly params: Readonly<Record<string, unknown>>;
	readonly timeoutMs: number;
};

export type DeviceProxyTarget = {
	readonly organizationId: OrganizationId;
	/** `null` only for the single-tenant env fallback, which has no device row. */
	readonly deviceId: string | null;
	readonly connectorId: string;
	readonly credentialRef: string;
};

export type DeviceProxyFactory = (
	target: DeviceProxyTarget,
) => DeviceProxy | null | Promise<DeviceProxy | null>;

export interface DeviceProxy {
	execute(request: ConnectorDeviceProxyRequest): Promise<DeviceProxyResult>;
}

const requestSchema = z.strictObject({
	connectorId: connectorIdSchema,
	credentialRef: connectorCredentialRefSchema,
	operation: z
		.string()
		.min(1)
		.max(MAX_DEVICE_PROXY_OPERATION_CHARS)
		.regex(OPERATION_PATTERN, "invalid operation"),
	params: z
		.record(
			z.string().min(1).max(MAX_DEVICE_PROXY_OPERATION_CHARS),
			z.unknown(),
		)
		.optional(),
	timeoutMs: z.number().int().positive().optional(),
});

function validationError(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

function assertJsonValue(value: unknown, depth: number, label: string): void {
	if (depth > MAX_DEVICE_PROXY_DEPTH) {
		throw validationError(`${label} is nested too deeply`);
	}
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw validationError(`${label} must be finite JSON`);
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_DEVICE_PROXY_ARRAY_ITEMS) {
			throw validationError(`${label} has too many items`);
		}
		for (const item of value) assertJsonValue(item, depth + 1, label);
		return;
	}
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw validationError(`${label} must be a plain JSON object`);
		}
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length > MAX_DEVICE_PROXY_PARAM_KEYS) {
			throw validationError(`${label} has too many keys`);
		}
		for (const [key, item] of entries) {
			if (FORBIDDEN_KEYS.has(key)) {
				throw validationError(`${label} has a forbidden key`);
			}
			assertJsonValue(item, depth + 1, label);
		}
		return;
	}
	throw validationError(`${label} must be JSON`);
}

/** Caps size, depth and shape so an untrusted payload cannot exhaust the worker. */
export function assertBoundedDeviceJson(
	value: unknown,
	label: string,
	maxBytes: number,
): void {
	assertJsonValue(value, 0, label);
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		throw validationError(`${label} must be JSON`);
	}
	if (text === undefined || byteLength(text) > maxBytes) {
		throw validationError(`${label} exceeds ${maxBytes} bytes`);
	}
}

/**
 * Validates an untrusted request at the boundary. Field values are never
 * echoed: Zod failures are reported as paths and codes only.
 */
export function normalizeConnectorDeviceProxyRequest(
	input: unknown,
): NormalizedConnectorDeviceProxyRequest {
	const parsed = requestSchema.safeParse(input);
	if (!parsed.success) {
		throw validationError(
			`connector device request is invalid: ${zodIssueSummary(parsed.error)}`,
		);
	}
	const params = parsed.data.params ?? {};
	assertBoundedDeviceJson(
		params,
		"connector device params",
		DEVICE_PROXY_MAX_PARAMS_BYTES,
	);
	const requestedTimeout =
		parsed.data.timeoutMs ?? DEVICE_PROXY_DEFAULT_TIMEOUT_MS;
	return {
		connectorId: parsed.data.connectorId,
		credentialRef: parsed.data.credentialRef,
		operation: parsed.data.operation,
		params: { ...params },
		timeoutMs: Math.min(
			DEVICE_PROXY_MAX_TIMEOUT_MS,
			Math.max(DEVICE_PROXY_MIN_TIMEOUT_MS, requestedTimeout),
		),
	};
}

/** A fixed, credential-free failure. Provider text is never accepted here. */
export function deviceProxyFailure(
	code: DeviceProxyErrorCode,
): DeviceProxyFailure {
	return {
		ok: false,
		error: { code, message: FAILURE_MESSAGES[code] },
	};
}

/** Wraps an untrusted device payload, failing closed if it is not bounded JSON. */
export function deviceProxySuccess(data: unknown): DeviceProxyResult {
	try {
		assertBoundedDeviceJson(
			data,
			"connector device response",
			DEVICE_PROXY_MAX_RESPONSE_BYTES,
		);
	} catch {
		return deviceProxyFailure("VALIDATION_FAILED");
	}
	return { ok: true, data };
}

/** Fails closed: the platform has no transport to any device. */
export class NullDeviceProxy implements DeviceProxy {
	async execute(
		_request: ConnectorDeviceProxyRequest,
	): Promise<DeviceProxyResult> {
		return deviceProxyFailure("INTEGRATION_UNAVAILABLE");
	}
}

export function createNullDeviceProxyFactory(): DeviceProxyFactory {
	return () => new NullDeviceProxy();
}
