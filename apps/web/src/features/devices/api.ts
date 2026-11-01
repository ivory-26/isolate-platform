import {
	API_FAILURE_MESSAGES,
	type ConnectConnectorInput,
	connectorConnectReceiptSchema,
	connectorListResponseSchema,
	connectorRevokeReceiptSchema,
	type DeviceApiFailureKind,
	type DeviceView,
	deviceListResponseSchema,
	failureKindForStatus,
	type IssuedDeviceToken,
	issuedDeviceTokenSchema,
	revokedDeviceSchema,
} from "./contracts";

/**
 * Same-origin JSON transport for the device and connector endpoints.
 *
 * Every request sends `credentials: "same-origin"`; POSTs declare
 * `Content-Type: application/json`. Failures are mapped to a fixed code and
 * fixed text — the response body is never surfaced, echoed or stored.
 */

export class DeviceApiError extends Error {
	readonly kind: DeviceApiFailureKind;

	constructor(kind: DeviceApiFailureKind) {
		super(API_FAILURE_MESSAGES[kind]);
		this.name = "DeviceApiError";
		this.kind = kind;
	}
}

export function toDeviceApiError(error: unknown): DeviceApiError {
	return error instanceof DeviceApiError
		? error
		: new DeviceApiError("unknown");
}

type RequestOptions = {
	readonly method: "GET" | "POST";
	readonly body?: unknown;
};

/** Minimal parser seam; every schema below is a Zod schema. */
type ResponseParser<T> = {
	safeParse(
		value: unknown,
	): { readonly success: true; readonly data: T } | { readonly success: false };
};

async function request<T>(
	path: string,
	options: RequestOptions,
	schema: ResponseParser<T>,
): Promise<T> {
	const hasBody = options.body !== undefined;
	let response: Response;
	try {
		response = await fetch(path, {
			method: options.method,
			credentials: "same-origin",
			cache: "no-store",
			headers: {
				Accept: "application/json",
				...(hasBody ? { "Content-Type": "application/json" } : {}),
			},
			body: hasBody ? JSON.stringify(options.body) : undefined,
		});
	} catch {
		throw new DeviceApiError("unknown");
	}
	if (!response.ok) {
		throw new DeviceApiError(failureKindForStatus(response.status));
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new DeviceApiError("unknown");
	}
	const parsed = schema.safeParse(payload);
	if (!parsed.success) throw new DeviceApiError("unknown");
	return parsed.data;
}

export async function listDevices(): Promise<DeviceView[]> {
	const response = await request(
		"/api/device/list",
		{ method: "GET" },
		deviceListResponseSchema,
	);
	return response.devices;
}

export function registerDevice(
	displayName: string,
): Promise<IssuedDeviceToken> {
	return request(
		"/api/device/register",
		{ method: "POST", body: { displayName } },
		issuedDeviceTokenSchema,
	);
}

export function rotateDevice(deviceId: string): Promise<IssuedDeviceToken> {
	return request(
		"/api/device/rotate",
		{ method: "POST", body: { deviceId } },
		issuedDeviceTokenSchema,
	);
}

export async function revokeDevice(deviceId: string): Promise<string> {
	const response = await request(
		"/api/device/revoke",
		{ method: "POST", body: { deviceId } },
		revokedDeviceSchema,
	);
	return response.deviceId;
}

export async function listConnectorCredentials() {
	const response = await request(
		"/api/connectors/list",
		{ method: "GET" },
		connectorListResponseSchema,
	);
	return response.credentials;
}

export async function connectConnector(
	input: ConnectConnectorInput,
): Promise<string> {
	const response = await request(
		"/api/connectors/connect",
		{
			method: "POST",
			body: {
				deviceId: input.deviceId,
				connectorId: input.connectorId,
				displayName: input.displayName,
				authKind: input.authKind,
				credentialRef: input.credentialRef,
				scopes: input.scopes,
			},
		},
		connectorConnectReceiptSchema,
	);
	return response.credentialId;
}

export async function revokeConnector(credentialId: string): Promise<string> {
	const response = await request(
		"/api/connectors/revoke",
		{ method: "POST", body: { credentialId } },
		connectorRevokeReceiptSchema,
	);
	return response.credentialId;
}
