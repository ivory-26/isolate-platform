import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { homedir } from "node:os";
import type {
	KubernetesHttpClient,
	KubernetesJsonResult,
	KubernetesQuery,
	KubernetesTextResult,
} from "@isolate/integrations";
import { PlatformError } from "@isolate/shared";

/**
 * Minimal HTTPS Kubernetes client for the device daemon.
 *
 * There is no kubeconfig support and no inline token: the daemon reads a
 * ServiceAccount token file and an optional cluster CA file at call time. The
 * bearer header is built per request and never logged. Timeout is fixed at
 * 10 seconds (clamped 1–30 s) and the response is capped at 256 KiB.
 *
 * The adapter only ever asks for a relative `/api/...` or `/apis/...` path, so
 * this client rejects anything else before building a URL.
 */

export const KUBERNETES_CLIENT_DEFAULT_TIMEOUT_MS = 10_000;
export const KUBERNETES_CLIENT_MIN_TIMEOUT_MS = 1_000;
export const KUBERNETES_CLIENT_MAX_TIMEOUT_MS = 30_000;
export const KUBERNETES_CLIENT_MAX_RESPONSE_BYTES = 256 * 1024;

const API_PATH_PATTERN = /^\/[A-Za-z0-9._~%/:-]*$/;

export type KubernetesHttpsClientOptions = {
	apiUrl: string;
	serviceAccountTokenFile: string;
	caFile?: string;
	timeoutMs?: number;
};

export function expandHomePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return `${homedir()}${path.slice(1)}`;
	}
	return path;
}

function parseApiBase(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"kubernetes api url is invalid",
		);
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"kubernetes api url is invalid",
		);
	}
	return url;
}

function parseTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return KUBERNETES_CLIENT_DEFAULT_TIMEOUT_MS;
	return Math.min(
		KUBERNETES_CLIENT_MAX_TIMEOUT_MS,
		Math.max(KUBERNETES_CLIENT_MIN_TIMEOUT_MS, Math.trunc(timeoutMs)),
	);
}

async function readRequiredFile(path: string, label: string): Promise<string> {
	let value: string;
	try {
		value = await readFile(expandHomePath(path), "utf8");
	} catch {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			`kubernetes ${label} could not be read`,
		);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			`kubernetes ${label} is empty`,
		);
	}
	return trimmed;
}

export function createKubernetesHttpsClient(
	options: KubernetesHttpsClientOptions,
): KubernetesHttpClient {
	const base = parseApiBase(options.apiUrl);
	const timeoutMs = parseTimeout(options.timeoutMs);

	const getRaw = async (
		path: string,
		query: KubernetesQuery | undefined,
	): Promise<{ status: number; text: string }> => {
		if (!API_PATH_PATTERN.test(path) || path.includes("..")) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"kubernetes api path is invalid",
			);
		}
		const url = new URL(path, base);
		if (url.origin !== base.origin) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"kubernetes api path is invalid",
			);
		}
		for (const [key, value] of Object.entries(query ?? {})) {
			url.searchParams.set(key, value);
		}
		const token = await readRequiredFile(
			options.serviceAccountTokenFile,
			"service account token",
		);
		const ca =
			options.caFile === undefined
				? undefined
				: await readRequiredFile(options.caFile, "ca certificate");
		return await new Promise<{ status: number; text: string }>(
			(resolve, reject) => {
				const req = request(
					url,
					{
						method: "GET",
						headers: {
							accept: "application/json",
							authorization: `Bearer ${token}`,
							"user-agent": "isolate-device-daemon",
						},
						timeout: timeoutMs,
						...(ca === undefined ? {} : { ca }),
					},
					(response) => {
						const chunks: Buffer[] = [];
						let total = 0;
						response.on("data", (chunk: Buffer) => {
							total += chunk.byteLength;
							if (total > KUBERNETES_CLIENT_MAX_RESPONSE_BYTES) {
								response.destroy(new Error("kubernetes response is too large"));
								return;
							}
							chunks.push(chunk);
						});
						response.on("end", () => {
							resolve({
								status: response.statusCode ?? 0,
								text: Buffer.concat(chunks).toString("utf8"),
							});
						});
						response.on("error", reject);
					},
				);
				req.on("timeout", () => {
					req.destroy(new Error("kubernetes request timed out"));
				});
				req.on("error", reject);
				req.end();
			},
		);
	};

	return {
		async get(
			path: string,
			query?: KubernetesQuery,
		): Promise<KubernetesJsonResult> {
			const { status, text } = await getRaw(path, query);
			let body: unknown = null;
			try {
				body = JSON.parse(text);
			} catch {
				body = null;
			}
			return { status, body };
		},
		async getText(
			path: string,
			query?: KubernetesQuery,
		): Promise<KubernetesTextResult> {
			const { status, text } = await getRaw(path, query);
			return { status, text };
		},
	};
}
