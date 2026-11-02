import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryLogger } from "./logger";
import {
	PAIRING_SESSION_TTL_MS,
	PairingServerError,
	type PairingServerHandle,
	parseSecretFieldInput,
	startPairingServer,
} from "./pairing-server";
import { openSecretStore } from "./secret-store";

/** Token-shaped fixtures are built at runtime, never static literals. */
function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Buffer.from(bytes).toString("base64url");
}

const deviceToken = randomToken();
const expectedCode = randomToken();
const pairingId = crypto.randomUUID();
const credentialId = crypto.randomUUID();
const relayId = crypto.randomUUID();
const CREDENTIAL_REF = "keychain:isolate/sentry/prod";

type GatewayState = {
	claims: number;
	completions: number;
	claimBody: unknown;
	completeBody: unknown;
};

const state: GatewayState = {
	claims: 0,
	completions: 0,
	claimBody: null,
	completeBody: null,
};

const gateway = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (
			request.method !== "POST" ||
			(request.headers.get("authorization") ?? "") !== `Bearer ${deviceToken}`
		) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}
		if (url.pathname === "/api/device/pairing/claim") {
			const body = (await request.json()) as { code?: unknown };
			state.claims += 1;
			state.claimBody = body;
			if (body.code !== expectedCode) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			return Response.json({
				pairingId,
				relayId,
				connectorId: "sentry",
				authKind: "api_key",
				credentialRef: CREDENTIAL_REF,
				displayName: "Sentry production",
				scopes: ["event:read"],
				expiresAt: new Date(Date.now() + 600_000).toISOString(),
			});
		}
		if (url.pathname === "/api/device/pairing/complete") {
			const body = (await request.json()) as { pairingId?: unknown };
			state.completions += 1;
			state.completeBody = body;
			if (body.pairingId !== pairingId) {
				return Response.json({ error: "conflict" }, { status: 409 });
			}
			return Response.json({
				credentialId,
				status: "pending_validation",
			});
		}
		return new Response("not found", { status: 404 });
	},
});

const servers: PairingServerHandle[] = [];
const directories: string[] = [];

afterAll(async () => {
	gateway.stop(true);
	for (const server of servers) await server.stop();
	for (const directory of directories) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function createStore(secretPath?: string) {
	const directory = await mkdtemp(join(tmpdir(), "isolate-pairing-"));
	directories.push(directory);
	const path = secretPath ?? join(directory, "secrets.json");
	return { path, store: await openSecretStore({ path, deviceToken }) };
}

async function startServer(
	options: { now?: () => number; sessionTtlMs?: number } = {},
): Promise<{
	server: PairingServerHandle;
	store: Awaited<ReturnType<typeof createStore>>["store"];
	path: string;
	lines: string[];
}> {
	const { path, store } = await createStore();
	const logger = createMemoryLogger();
	const server = await startPairingServer({
		serverUrl: `http://127.0.0.1:${gateway.port}`,
		deviceToken,
		secretStore: store,
		port: 0,
		logger,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.sessionTtlMs === undefined
			? {}
			: { sessionTtlMs: options.sessionTtlMs }),
	});
	servers.push(server);
	return { server, store, path, lines: logger.lines };
}

async function openPage(localUrl: string, code: string): Promise<string> {
	const response = await fetch(`${localUrl}?code=${encodeURIComponent(code)}`);
	expect(response.status).toBe(200);
	return response.text();
}

function readNonce(html: string): string {
	const match = /name="nonce" value="([A-Za-z0-9_-]{43})"/.exec(html);
	if (match === null || match[1] === undefined) {
		throw new Error("nonce missing from pairing page");
	}
	return match[1];
}

async function postForm(
	localUrl: string,
	fields: Record<string, string>,
	options: { origin?: string; contentType?: string } = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": options.contentType ?? "application/x-www-form-urlencoded",
		origin: options.origin ?? localUrl,
	};
	return fetch(`${localUrl.replace(/\/pair$/, "")}/pair`, {
		method: "POST",
		headers,
		body: new URLSearchParams(fields),
	});
}

describe("localhost pairing page", () => {
	test("serves a strict-CSP page and accepts a fake secret once", async () => {
		const { server, store, path, lines } = await startServer();
		const html = await openPage(server.localUrl, expectedCode);
		expect(html).toContain('name="nonce"');
		expect(html).not.toContain(expectedCode);
		const nonce = readNonce(html);

		const page = await fetch(`${server.localUrl}?code=${expectedCode}`);
		expect(page.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
		expect(page.headers.get("access-control-allow-origin")).toBeNull();
		expect(page.headers.get("cache-control")).toBe("no-store");

		const secret = randomToken();
		const before = state.claims;
		const response = await postForm(server.localUrl, {
			nonce,
			secret,
			selectors: JSON.stringify({ orgSlug: "acme" }),
		});
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("Provider connected");
		expect(body).not.toContain(secret);
		expect(state.claims).toBe(before + 1);
		expect(state.completions).toBe(1);
		expect(state.completeBody).toEqual({ pairingId });
		expect(state.claimBody).toEqual({ code: expectedCode });
		expect(store.getFields(CREDENTIAL_REF)).toEqual({ token: secret });
		expect(store.getSelectors(CREDENTIAL_REF)).toEqual({ orgSlug: "acme" });

		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain(secret);
		expect(lines.join("\n")).not.toContain(secret);
		expect(lines.join("\n")).not.toContain(expectedCode);

		// The nonce is one-time: a replay never reaches the gateway.
		const replay = await postForm(server.localUrl, { nonce, secret });
		expect(replay.status).toBe(400);
		expect(state.claims).toBe(before + 1);
	});

	test("rejects a missing or unknown nonce without a claim", async () => {
		const { server } = await startServer();
		await openPage(server.localUrl, expectedCode);
		const before = state.claims;
		const missing = await postForm(server.localUrl, {
			secret: randomToken(),
		});
		expect(missing.status).toBe(400);
		const unknown = await postForm(server.localUrl, {
			nonce: randomToken(),
			secret: randomToken(),
		});
		expect(unknown.status).toBe(400);
		expect(state.claims).toBe(before);
	});

	test("rejects a malformed pairing code before rendering a form", async () => {
		const { server } = await startServer();
		const response = await fetch(`${server.localUrl}?code=short`);
		expect(response.status).toBe(400);
		const missing = await fetch(server.localUrl);
		expect(missing.status).toBe(400);
	});

	test("an unknown code fails at the gateway without storing anything", async () => {
		const { server, store } = await startServer();
		const html = await openPage(server.localUrl, randomToken());
		const nonce = readNonce(html);
		const before = state.claims;
		const response = await postForm(server.localUrl, {
			nonce,
			secret: randomToken(),
		});
		expect(response.status).toBe(502);
		expect(state.claims).toBe(before + 1);
		expect(store.refs()).toEqual([]);
	});

	test("refuses a cross-origin POST before consuming the nonce", async () => {
		const { server } = await startServer();
		const html = await openPage(server.localUrl, expectedCode);
		const nonce = readNonce(html);
		const before = state.claims;
		const blocked = await postForm(
			server.localUrl,
			{ nonce, secret: randomToken() },
			{ origin: "https://evil.example" },
		);
		expect(blocked.status).toBe(403);
		expect(state.claims).toBe(before);
		// Same-origin retry with the same nonce still works: nothing was spent.
		const accepted = await postForm(server.localUrl, {
			nonce,
			secret: randomToken(),
		});
		expect(accepted.status).toBe(200);
	});

	test("requires a form content type", async () => {
		const { server } = await startServer();
		const html = await openPage(server.localUrl, expectedCode);
		const nonce = readNonce(html);
		const response = await postForm(
			server.localUrl,
			{ nonce, secret: randomToken() },
			{ contentType: "application/json" },
		);
		expect(response.status).toBe(415);
	});

	test("a session older than ten minutes is refused", async () => {
		let current = 1_000_000;
		const { server } = await startServer({
			now: () => current,
			sessionTtlMs: PAIRING_SESSION_TTL_MS,
		});
		const html = await openPage(server.localUrl, expectedCode);
		const nonce = readNonce(html);
		current += PAIRING_SESSION_TTL_MS + 1;
		const response = await postForm(server.localUrl, {
			nonce,
			secret: randomToken(),
		});
		expect(response.status).toBe(400);
	});

	test("accepts a JSON object of named secret fields", async () => {
		const { server, store } = await startServer();
		const html = await openPage(server.localUrl, expectedCode);
		const nonce = readNonce(html);
		const apiKey = randomToken();
		const appKey = randomToken();
		const response = await postForm(server.localUrl, {
			nonce,
			secret: JSON.stringify({ apiKey, appKey }),
		});
		expect(response.status).toBe(200);
		expect(store.getFields(CREDENTIAL_REF)).toEqual({ apiKey, appKey });
	});

	test("refuses a non-loopback bind", async () => {
		const { store } = await createStore();
		await expect(
			startPairingServer({
				serverUrl: `http://127.0.0.1:${gateway.port}`,
				deviceToken,
				secretStore: store,
				port: 0,
				hostname: "0.0.0.0",
			}),
		).rejects.toBeInstanceOf(PairingServerError);
	});
});

describe("pairing form parsing", () => {
	test("a plain value becomes the token field", () => {
		expect(parseSecretFieldInput("  value  ")).toEqual({ token: "value" });
		expect(parseSecretFieldInput("   ")).toBeNull();
		expect(parseSecretFieldInput(null)).toBeNull();
	});

	test("a JSON object keeps named fields and rejects non-strings", () => {
		expect(parseSecretFieldInput('{"apiKey":"a","appKey":"b"}')).toEqual({
			apiKey: "a",
			appKey: "b",
		});
		expect(parseSecretFieldInput('{"apiKey":1}')).toBeNull();
		expect(parseSecretFieldInput("{}")).toBeNull();
		expect(parseSecretFieldInput("{not json")).toBeNull();
	});
});
