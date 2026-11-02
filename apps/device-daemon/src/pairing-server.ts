import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PAIRING_DEFAULT_PORT, PAIRING_LOOPBACK_HOST } from "./config";
import { createConsoleLogger, type Logger } from "./logger";
import type { SecretStore } from "./secret-store";

/**
 * One-time localhost pairing page served by the relay daemon.
 *
 * The browser opens `http://127.0.0.1:<port>/pair?code=...` (the URL the server
 * returned to the owner). The page contains a fresh CSRF nonce; the POST claims
 * the code with the device bearer token, writes the pasted provider secret to
 * the encrypted local store, completes the pairing on the server and shows a
 * fixed success page. The secret is only ever in the POST body, the daemon's
 * memory and the encrypted file: never a URL, a log line or an HTML response.
 *
 * The listener refuses any non-loopback bind, sends no CORS headers, sets a
 * strict CSP, expires sessions after ten minutes and accepts each nonce once.
 */

export const PAIRING_SESSION_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_SESSIONS = 32;
export const PAIRING_MAX_BODY_BYTES = 32 * 1024;
export const PAIRING_MAX_RESPONSE_BYTES = 32 * 1024;

const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class PairingServerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PairingServerError";
	}
}

/** Refuses to bind anything but loopback; the caller never gets a public port. */
export function assertLoopbackHostname(hostname: string): void {
	if (
		hostname !== "127.0.0.1" &&
		hostname !== "::1" &&
		hostname !== "localhost"
	) {
		throw new PairingServerError("pairing server must bind to loopback");
	}
}

const claimResponseSchema = z.strictObject({
	pairingId: z.uuid(),
	relayId: z.uuid(),
	connectorId: z.string().min(1).max(32),
	authKind: z.string().min(1).max(64),
	credentialRef: z.string().min(1).max(200),
	displayName: z.string().min(1).max(100),
	scopes: z.array(z.string().max(64)).max(32),
	expiresAt: z.iso.datetime({ offset: true }),
});

const completeResponseSchema = z.strictObject({
	credentialId: z.uuid(),
	status: z.literal("pending_validation"),
});

type PairingSession = {
	code: string;
	expiresAt: number;
};

export type PairingServerOptions = {
	serverUrl: string;
	deviceToken: string;
	secretStore: Pick<SecretStore, "setSecret">;
	port?: number;
	/** Test seam only; production binds 127.0.0.1. */
	hostname?: string;
	fetchImpl?: typeof fetch;
	logger?: Logger;
	now?: () => number;
	sessionTtlMs?: number;
};

export type PairingServerHandle = {
	readonly port: number;
	readonly localUrl: string;
	stop(): Promise<void>;
};

const HTML_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
	pragma: "no-cache",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
} as const;

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:2rem;background:#0b0d12;color:#e8eaf0}
main{max-width:34rem;margin:0 auto}
label{display:block;margin:1rem 0 .25rem;font-weight:600}
textarea{width:100%;min-height:5rem;box-sizing:border-box;font-family:ui-monospace,monospace;background:#141824;color:#e8eaf0;border:1px solid #2a3040;border-radius:6px;padding:.5rem}
button{margin-top:1rem;padding:.6rem 1rem;border-radius:6px;border:0;background:#4f7cff;color:#fff;font-weight:600}
p{line-height:1.5;color:#aab1c0}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function errorResponse(status: number, message: string): Response {
	return new Response(
		page(
			"Pairing failed",
			`<h1>Pairing failed</h1><p>${escapeHtml(message)}</p>`,
		),
		{ status, headers: HTML_HEADERS },
	);
}

const GENERIC_ERROR =
	"Return to Isolate, start the pairing again and paste the credential on the new page.";

/**
 * Accepts either one pasted value or a JSON object of named fields (for a
 * provider that needs two keys, for example `{"apiKey":"...","appKey":"..."}`).
 */
export function parseSecretFieldInput(
	value: string | null,
): Record<string, string> | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 64 * 1024) return null;
	if (!trimmed.startsWith("{")) return { token: trimmed };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const fields: Record<string, string> = Object.create(null);
	for (const [key, fieldValue] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
			return null;
		}
		fields[key] = fieldValue;
	}
	return Object.keys(fields).length === 0 ? null : fields;
}

function parseSelectorsInput(
	value: string | null,
): Record<string, string> | null | undefined {
	if (value === null) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const selectors: Record<string, string> = Object.create(null);
	for (const [key, selectorValue] of Object.entries(
		parsed as Record<string, unknown>,
	)) {
		if (typeof selectorValue !== "string") return null;
		selectors[key] = selectorValue;
	}
	return selectors;
}

function endpoint(serverUrl: string, path: string): string {
	return `${serverUrl.replace(/\/+$/, "")}${path}`;
}

async function readBoundedText(
	response: Response,
	maxBytes: number,
): Promise<string | null> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return null;
	}
	return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
}

async function readBoundedBody(
	request: Request,
	maxBytes: number,
): Promise<string | null> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (!Number.isFinite(length) || length > maxBytes) return null;
	}
	if (request.body === null) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let finished = false;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) {
				finished = true;
				break;
			}
			total += next.value.byteLength;
			if (total > maxBytes) return null;
			chunks.push(next.value);
		}
	} finally {
		if (!finished) await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function isFormRequest(request: Request): boolean {
	const contentType = request.headers.get("content-type");
	if (contentType === null) return false;
	const [mediaType] = contentType.split(";", 1);
	return mediaType.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

export async function startPairingServer(
	options: PairingServerOptions,
): Promise<PairingServerHandle> {
	const hostname = options.hostname ?? PAIRING_LOOPBACK_HOST;
	assertLoopbackHostname(hostname);
	const port = options.port ?? PAIRING_DEFAULT_PORT;
	// `0` is the test seam for an ephemeral port; the config never allows it.
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
		throw new PairingServerError("pairing port is invalid");
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const logger = options.logger ?? createConsoleLogger();
	const now = options.now ?? (() => Date.now());
	const sessionTtlMs = options.sessionTtlMs ?? PAIRING_SESSION_TTL_MS;
	const sessions = new Map<string, PairingSession>();

	const purgeExpired = (): void => {
		const at = now();
		for (const [nonce, session] of sessions) {
			if (session.expiresAt <= at) sessions.delete(nonce);
		}
	};

	const claimPairing = async (
		code: string,
	): Promise<z.output<typeof claimResponseSchema> | null> => {
		let response: Response;
		try {
			response = await fetchImpl(
				endpoint(options.serverUrl, "/api/device/pairing/claim"),
				{
					method: "POST",
					headers: {
						accept: "application/json",
						"content-type": "application/json",
						authorization: `Bearer ${options.deviceToken}`,
					},
					body: JSON.stringify({ code }),
					signal: AbortSignal.timeout(15_000),
				},
			);
		} catch {
			return null;
		}
		if (response.status !== 200) return null;
		const text = await readBoundedText(response, PAIRING_MAX_RESPONSE_BYTES);
		if (text === null) return null;
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return null;
		}
		const parsed = claimResponseSchema.safeParse(raw);
		return parsed.success ? parsed.data : null;
	};

	const completePairing = async (pairingId: string): Promise<boolean> => {
		let response: Response;
		try {
			response = await fetchImpl(
				endpoint(options.serverUrl, "/api/device/pairing/complete"),
				{
					method: "POST",
					headers: {
						accept: "application/json",
						"content-type": "application/json",
						authorization: `Bearer ${options.deviceToken}`,
					},
					body: JSON.stringify({ pairingId }),
					signal: AbortSignal.timeout(15_000),
				},
			);
		} catch {
			return false;
		}
		if (response.status !== 200) return false;
		const text = await readBoundedText(response, PAIRING_MAX_RESPONSE_BYTES);
		if (text === null) return false;
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			return false;
		}
		return completeResponseSchema.safeParse(raw).success;
	};

	const server = Bun.serve({
		hostname,
		port,
		async fetch(request) {
			let url: URL;
			try {
				url = new URL(request.url);
			} catch {
				return errorResponse(400, GENERIC_ERROR);
			}
			if (url.pathname !== "/pair") {
				return errorResponse(404, "Not found.");
			}
			if (request.method === "GET") {
				const code = url.searchParams.get("code");
				if (code === null || !PAIRING_CODE_PATTERN.test(code)) {
					return errorResponse(400, GENERIC_ERROR);
				}
				purgeExpired();
				// Bound the in-memory session table; the oldest entry is dropped.
				while (sessions.size >= PAIRING_MAX_SESSIONS) {
					const oldest = sessions.keys().next().value;
					if (oldest === undefined) break;
					sessions.delete(oldest);
				}
				const nonce = randomBytes(32).toString("base64url");
				sessions.set(nonce, {
					code,
					expiresAt: now() + sessionTtlMs,
				});
				const form = page(
					"Connect a provider",
					`<h1>Connect a provider</h1>
<p>Paste the provider credential below. It is stored only on this device, encrypted with a key derived from the relay token. It is never sent to the Isolate server.</p>
<form method="post" action="/pair">
<input type="hidden" name="nonce" value="${nonce}">
<label for="secret">Provider secret</label>
<textarea id="secret" name="secret" required autocomplete="off" spellcheck="false"></textarea>
<p>If the provider needs two keys, paste a JSON object such as <code>{"apiKey":"...","appKey":"..."}</code>.</p>
<label for="selectors">Optional non-secret selectors (JSON)</label>
<textarea id="selectors" name="selectors" autocomplete="off" spellcheck="false" placeholder='{"orgSlug":"acme"}'></textarea>
<button type="submit">Store secret and finish</button>
</form>
<p>This page is available only on 127.0.0.1 and expires in ten minutes.</p>`,
				);
				return new Response(form, { status: 200, headers: HTML_HEADERS });
			}
			if (request.method !== "POST") {
				return errorResponse(405, "Method not allowed.");
			}

			// No CORS: a cross-site form post is refused before the body is read.
			const origin = request.headers.get("origin");
			if (origin !== null) {
				let originHost: string | null = null;
				try {
					originHost = new URL(origin).host.toLowerCase();
				} catch {
					originHost = null;
				}
				const expected = request.headers.get("host")?.toLowerCase() ?? null;
				if (
					expected === null ||
					originHost === null ||
					originHost !== expected
				) {
					logger.warn("pairing", { status: "failed", stage: "origin" });
					return errorResponse(403, GENERIC_ERROR);
				}
			}
			const fetchSite = request.headers
				.get("sec-fetch-site")
				?.trim()
				.toLowerCase();
			if (
				fetchSite !== undefined &&
				fetchSite.length > 0 &&
				fetchSite !== "same-origin" &&
				fetchSite !== "none"
			) {
				logger.warn("pairing", { status: "failed", stage: "origin" });
				return errorResponse(403, GENERIC_ERROR);
			}
			if (!isFormRequest(request)) {
				return errorResponse(415, GENERIC_ERROR);
			}
			const body = await readBoundedBody(request, PAIRING_MAX_BODY_BYTES);
			if (body === null) {
				return errorResponse(413, GENERIC_ERROR);
			}
			const params = new URLSearchParams(body);
			const nonce = params.get("nonce");
			if (nonce === null || !NONCE_PATTERN.test(nonce)) {
				return errorResponse(400, GENERIC_ERROR);
			}
			// One-time: the session is consumed before any network call.
			const session = sessions.get(nonce);
			sessions.delete(nonce);
			if (session === undefined || session.expiresAt <= now()) {
				logger.warn("pairing", { status: "failed", stage: "session" });
				return errorResponse(400, GENERIC_ERROR);
			}
			const fields = parseSecretFieldInput(params.get("secret"));
			if (fields === null) {
				logger.warn("pairing", { status: "failed", stage: "secret" });
				return errorResponse(400, GENERIC_ERROR);
			}
			const selectors = parseSelectorsInput(params.get("selectors"));
			if (selectors === null) {
				logger.warn("pairing", { status: "failed", stage: "selectors" });
				return errorResponse(400, GENERIC_ERROR);
			}
			const claim = await claimPairing(session.code);
			if (claim === null) {
				logger.warn("pairing", { status: "failed", stage: "claim" });
				return errorResponse(502, GENERIC_ERROR);
			}
			logger.info("pairing", {
				status: "claimed",
				connector: claim.connectorId,
			});
			try {
				await options.secretStore.setSecret(claim.credentialRef, {
					fields: { ...fields },
					...(selectors === undefined ? {} : { selectors }),
				});
			} catch {
				logger.warn("pairing", { status: "failed", stage: "store" });
				return errorResponse(500, GENERIC_ERROR);
			}
			const completed = await completePairing(claim.pairingId);
			if (!completed) {
				logger.warn("pairing", { status: "failed", stage: "complete" });
				return errorResponse(502, GENERIC_ERROR);
			}
			logger.info("pairing", { status: "completed" });
			const success = page(
				"Provider connected",
				`<h1>Provider connected</h1>
<p>${escapeHtml(claim.displayName)} has been stored on this relay. You can close this tab and return to Isolate.</p>`,
			);
			return new Response(success, { status: 200, headers: HTML_HEADERS });
		},
	});

	const actualPort = server.port ?? port;
	logger.info("pairing", { status: "listening", port: actualPort });

	return {
		port: actualPort,
		localUrl: `http://${PAIRING_LOOPBACK_HOST}:${actualPort}/pair`,
		async stop() {
			server.stop(true);
		},
	};
}
