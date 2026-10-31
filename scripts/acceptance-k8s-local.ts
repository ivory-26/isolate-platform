import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import {
	fetchKubernetesContext,
	type KubernetesHttpClient,
	type KubernetesQuery,
} from "../packages/integrations/src/kubernetes/index";
import { MAX_CONTEXT_EXCERPT_CHARS } from "../packages/shared/src/types/incident";

/**
 * Local Kubernetes acceptance (kind cluster, read-only ServiceAccount).
 *
 * One bounded context read over HTTPS with a namespaced token file and the
 * cluster CA. The token is read from disk and never printed; the client is the
 * same injected `KubernetesHttpClient` shape the adapter is tested against.
 *
 * Required env (names only):
 *   K8S_API_URL, K8S_NAMESPACE, K8S_TOKEN_FILE, K8S_CA_FILE,
 *   K8S_NAME (pod name), optional K8S_CONTAINER.
 */

if (process.env.K8S_ACCEPTANCE !== "1") {
	console.log("Set K8S_ACCEPTANCE=1 to run the local Kubernetes acceptance.");
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

const apiUrl = new URL(required("K8S_API_URL"));
assert.equal(apiUrl.protocol, "https:");
const namespace = required("K8S_NAMESPACE");
const token = readFileSync(required("K8S_TOKEN_FILE"), "utf8").trim();
const ca = readFileSync(required("K8S_CA_FILE"));
const name = required("K8S_NAME");
const container = process.env.K8S_CONTAINER?.trim() || undefined;

function call(
	path: string,
	query: KubernetesQuery | undefined,
	raw: boolean,
): Promise<{ status: number; body: string }> {
	const url = new URL(path, apiUrl);
	for (const [key, value] of Object.entries(query ?? {})) {
		url.searchParams.set(key, value);
	}
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method: "GET",
				ca,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: raw ? "text/plain" : "application/json",
				},
				timeout: 10_000,
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
					if (body.length > 512 * 1024) req.destroy(new Error("caps"));
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body }),
				);
			},
		);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", reject);
		req.end();
	});
}

const client: KubernetesHttpClient = {
	async get(path, query) {
		const result = await call(path, query, false);
		let body: unknown = null;
		try {
			body = JSON.parse(result.body);
		} catch {
			body = null;
		}
		return { status: result.status, body };
	},
	async getText(path, query) {
		const result = await call(path, query, true);
		return { status: result.status, text: result.body };
	},
};

try {
	const bundle = await fetchKubernetesContext(
		{ client, namespace, clusterId: "kind-isolate-demo" },
		{
			incidentFingerprint: "k8s:kind-isolate-demo:acceptance",
			namespace,
			kind: "Pod",
			name,
			podName: name,
			...(container === undefined ? {} : { container }),
			includeLogs: true,
		},
	);

	assert.ok(bundle.items.length > 0, "context bundle is empty");
	let bytes = 0;
	for (const item of bundle.items) {
		assert.equal(item.source, "kubernetes");
		assert.equal(item.trustLevel, "untrusted");
		assert.ok(item.excerpt.length <= MAX_CONTEXT_EXCERPT_CHARS);
		assert.match(item.sha256, /^[0-9a-f]{64}$/);
		assert.ok(item.url !== undefined || item.path !== undefined);
		bytes += Buffer.byteLength(item.excerpt);
	}
	assert.ok(bytes <= 256 * 1024, "context total exceeds 256 KiB");

	console.log(
		JSON.stringify(
			{
				namespace,
				items: bundle.items.length,
				truncated: bundle.truncated,
				kinds: bundle.items.map((item) => item.kind),
				excerptBytes: bytes,
			},
			null,
			1,
		),
	);
	console.log("LOCAL KUBERNETES ACCEPTANCE PASSED");
} catch (error) {
	const message = error instanceof Error ? error.message.slice(0, 300) : "unknown";
	console.error(`LOCAL KUBERNETES ACCEPTANCE FAILED: ${message}`);
	process.exit(1);
}
