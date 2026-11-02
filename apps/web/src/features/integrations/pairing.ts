import { DeviceApiError } from "../devices/api";
import {
	API_FAILURE_MESSAGES,
	type DeviceApiFailureKind,
	failureKindForStatus,
	looksLikeCredentialSecret,
} from "../devices/contracts";
import {
	type CreatePairingInput,
	createPairingInputSchema,
	type PairingCreateView,
	type PairingSessionView,
	pairingCancelViewSchema,
	pairingCreateViewSchema,
	pairingSessionViewSchema,
} from "./contracts";

/**
 * Browser transport for the relay pairing routes (RELAY lane contract).
 *
 * The browser sends metadata only: relay id, connector id, display name, auth
 * kind, an opaque keychain item name and scopes. The provider secret is typed
 * on the relay's loopback page and never enters this request.
 *
 * Routes:
 *   POST /api/device/pairing               -> { pairingId, code, localUrl, expiresAt }
 *   GET  /api/device/pairing/{pairingId}   -> { pairingId, status, expiresAt, credentialId? }
 *   POST /api/device/pairing/cancel        -> { pairingId, status: "cancelled" }
 */

export const PAIRING_POLL_INTERVAL_MS = 2_000;

class PairingApiError extends DeviceApiError {
	constructor(kind: DeviceApiFailureKind = "unknown") {
		super(kind);
		this.name = "PairingApiError";
	}
}

type ResponseParser<T> = {
	safeParse(
		value: unknown,
	): { readonly success: true; readonly data: T } | { readonly success: false };
};

async function request<T>(
	path: string,
	method: "GET" | "POST",
	body: unknown,
	schema: ResponseParser<T>,
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			credentials: "same-origin",
			cache: "no-store",
			headers: {
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		throw new PairingApiError("unknown");
	}
	if (!response.ok)
		throw new PairingApiError(failureKindForStatus(response.status));
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new PairingApiError("unknown");
	}
	const parsed = schema.safeParse(payload);
	if (!parsed.success) throw new PairingApiError("unknown");
	return parsed.data;
}

export function createPairing(
	input: CreatePairingInput,
): Promise<PairingCreateView> {
	const parsed = createPairingInputSchema.safeParse(input);
	if (!parsed.success) {
		return Promise.reject(new PairingApiError("invalid"));
	}
	if (looksLikeCredentialSecret(parsed.data.credentialRef)) {
		return Promise.reject(new PairingApiError("invalid"));
	}
	return request(
		"/api/device/pairing",
		"POST",
		{
			relayId: parsed.data.relayId,
			connectorId: parsed.data.connectorId,
			displayName: parsed.data.displayName,
			authKind: parsed.data.authKind,
			credentialRef: parsed.data.credentialRef,
			scopes: parsed.data.scopes,
		},
		pairingCreateViewSchema,
	);
}

export function getPairingStatus(
	pairingId: string,
): Promise<PairingSessionView> {
	return request(
		`/api/device/pairing/${encodeURIComponent(pairingId)}`,
		"GET",
		undefined,
		pairingSessionViewSchema,
	);
}

export function cancelPairing(
	pairingId: string,
): Promise<{ pairingId: string; status: "cancelled" }> {
	return request(
		"/api/device/pairing/cancel",
		"POST",
		{ pairingId },
		pairingCancelViewSchema,
	);
}

export function pairingErrorMessage(error: unknown): string {
	if (error instanceof DeviceApiError) {
		return error.message || API_FAILURE_MESSAGES.unknown;
	}
	return API_FAILURE_MESSAGES.unknown;
}
