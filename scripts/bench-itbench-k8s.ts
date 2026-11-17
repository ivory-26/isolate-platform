import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	fetchKubernetesContext,
	type KubernetesHttpClient,
	type KubernetesJsonResult,
	type KubernetesQuery,
	type KubernetesTextResult,
} from "../packages/integrations/src/kubernetes/context";

/**
 * ITBench-AA Kubernetes evidence pilot (offline, no cluster, no model).
 *
 * Reads a downloaded ITBench-AA scenario snapshot (public Hugging Face
 * dataset `ArtificialAnalysis/ITBench-AA`), serves the five Kubernetes API
 * reads the production reader makes from an in-memory index of the snapshot,
 * then calls the REAL `fetchKubernetesContext` and scores its evidence bundle
 * against the scenario ground truth.
 *
 * Files needed in `--data <dir>`:
 *   k8s_objects_raw.tsv   (44 MB)
 *   k8s_events_raw.tsv    (1.5 MB)
 *   ground_truth.yaml     (1.3 kB, parsed by a narrow reader below)
 * `otel_logs_raw.tsv` is NOT required; log tails are reported as absent.
 *
 * Nothing here contacts a vendor, a cluster or a model provider.
 */

type RawObject = {
	kind?: string;
	metadata?: {
		name?: string;
		namespace?: string;
		labels?: Record<string, string>;
		ownerReferences?: { kind?: string; name?: string }[];
	};
	spec?: Record<string, unknown>;
	status?: Record<string, unknown>;
};

type IndexedObject = { kind: string; namespace: string; name: string; body: unknown };

type EventItem = {
	type?: string;
	involvedObject?: { kind?: string; name?: string; namespace?: string };
	reason?: string;
	message?: string;
	count?: number;
	firstTimestamp?: string;
	lastTimestamp?: string;
	eventTime?: string;
	metadata?: { name?: string; namespace?: string };
};

/** Minimal TSV reader: quoted fields with doubled quotes, may span newlines. */
function parseTsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
			continue;
		}
		if (ch === '"') {
			quoted = true;
			continue;
		}
		if (ch === "\t") {
			row.push(field);
			field = "";
			continue;
		}
		if (ch === "\n") {
			row.push(field);
			field = "";
			rows.push(row);
			row = [];
			continue;
		}
		if (ch === "\r") continue;
		field += ch;
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function bodyColumn(rows: string[][]): unknown[] {
	if (rows.length === 0) return [];
	const header = rows[0] ?? [];
	const bodyIndex = header.indexOf("Body");
	if (bodyIndex < 0) throw new Error("TSV has no Body column");
	const out: unknown[] = [];
	for (const row of rows.slice(1)) {
		const raw = row[bodyIndex];
		if (raw === undefined || raw.trim().length === 0) continue;
		try {
			out.push(JSON.parse(raw));
		} catch {
			// A malformed row is skipped; the counts are reported.
		}
	}
	return out;
}

function buildIndex(objects: unknown[]): Map<string, unknown> {
	const index = new Map<string, unknown>();
	for (const candidate of objects) {
		const object = candidate as RawObject;
		const kind = object.kind;
		const name = object.metadata?.name;
		const namespace = object.metadata?.namespace ?? "";
		if (typeof kind !== "string" || typeof name !== "string") continue;
		index.set(`${kind}/${namespace}/${name}`, object);
	}
	return index;
}

function namesOfKind(index: Map<string, unknown>, kind: string, namespace: string): string[] {
	const names: string[] = [];
	for (const value of index.values()) {
		const object = value as RawObject;
		if (object.kind !== kind) continue;
		if ((object.metadata?.namespace ?? "") !== namespace) continue;
		const name = object.metadata?.name;
		if (typeof name === "string") names.push(name);
	}
	return names.sort();
}

function matchSelector(object: RawObject, selector: string): boolean {
	const labels = object.metadata?.labels ?? {};
	for (const pair of selector.split(",")) {
		const [key, expected] = pair.split("=");
		if (key === undefined || expected === undefined) continue;
		if (labels[key] !== expected) return false;
	}
	return true;
}

function pathParts(path: string): string[] {
	return path.split("?")[0]?.split("/").filter((part) => part.length > 0) ?? [];
}

function kubernetesClient(
	index: Map<string, unknown>,
	events: EventItem[],
	missing: string[],
): KubernetesHttpClient {
	const get = async (path: string, query?: KubernetesQuery): Promise<KubernetesJsonResult> => {
		const parts = pathParts(path);
		const nsIndex = parts.indexOf("namespaces");
		const namespace = nsIndex >= 0 ? (parts[nsIndex + 1] ?? "") : "";
		const rest = parts.slice(nsIndex + 2);

		if (rest[0] === "events") {
			const selector = query?.fieldSelector ?? "";
			const nameMatch = /involvedObject\.name=([^,]+)/.exec(selector)?.[1];
			const warningOnly = selector.includes("type=Warning");
			const items = events.filter((event) => {
				if (nameMatch !== undefined && event.involvedObject?.name !== nameMatch) return false;
				if (warningOnly && event.type !== "Warning") return false;
				return (event.metadata?.namespace ?? namespace) === namespace;
			});
			return { status: 200, body: { kind: "EventList", items } };
		}
		if (rest[0] === "pods" && rest.length >= 2 && rest[1] !== "log") {
			const body = index.get(`Pod/${namespace}/${rest[1]}`);
			return body === undefined ? missing404(missing, path) : { status: 200, body };
		}
		if (rest[0] === "pods" && rest[1] !== undefined && rest[2] === "log") {
			missing.push(path);
			return { status: 404, body: { kind: "Status", code: 404 } };
		}
		if (rest[0] === "deployments" && rest[1] !== undefined) {
			const body = index.get(`Deployment/${namespace}/${rest[1]}`);
			return body === undefined ? missing404(missing, path) : { status: 200, body };
		}
		if (rest[0] === "replicasets") {
			const selector = query?.labelSelector ?? "";
			const items: unknown[] = [];
			for (const value of index.values()) {
				const object = value as RawObject;
				if (object.kind !== "ReplicaSet") continue;
				if ((object.metadata?.namespace ?? "") !== namespace) continue;
				if (!matchSelector(object, selector)) continue;
				items.push(object);
			}
			return { status: 200, body: { kind: "ReplicaSetList", items } };
		}
		missing.push(path);
		return { status: 404, body: { kind: "Status", code: 404 } };
	};

	const getText = async (path: string): Promise<KubernetesTextResult> => {
		missing.push(path);
		return { status: 404, text: "" };
	};

	return { get, getText };
}

function missing404(missing: string[], path: string): KubernetesJsonResult {
	missing.push(path);
	return { status: 404, body: { kind: "Status", code: 404 } };
}

function tokens(text: string): string[] {
	return text
		.split(/[^A-Za-z0-9_]+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 3);
}

function digest(items: { kind: string; excerpt: string }[]): string {
	const hash = createHash("sha256");
	for (const item of items) hash.update(`${item.kind}\u0000${item.excerpt}\u0000`);
	return hash.digest("hex").slice(0, 16);
}

const dataDir = process.argv[process.argv.indexOf("--data") + 1];
if (dataDir === undefined || dataDir.startsWith("--")) {
	throw new Error("usage: bun scripts/bench-itbench-k8s.ts --data <scenario-dir>");
}

const objectsText = readFileSync(join(dataDir, "k8s_objects_raw.tsv"), "utf8");
const eventsText = readFileSync(join(dataDir, "k8s_events_raw.tsv"), "utf8");
const groundTruth = readFileSync(join(dataDir, "ground_truth.yaml"), "utf8");

const objects = bodyColumn(parseTsv(objectsText));
const eventBodies = bodyColumn(parseTsv(eventsText));
const index = buildIndex(objects);
const events: EventItem[] = eventBodies
	.map((body) => (body as { object?: EventItem }).object)
	.filter((value): value is EventItem => value !== undefined);

/**
 * ITBench-AA groups use synthetic ids (`shipping-deployment-1`) with a regex
 * filter; the cluster object has the real name (`shipping`). Resolve the root
 * group against the snapshot instead of passing the synthetic id to the API.
 */
type GroundTruthGroup = {
	id: string;
	kind: string;
	namespace: string;
	filter: string;
	rootCause: boolean;
};

function parseGroups(yaml: string): GroundTruthGroup[] {
	const groups: GroundTruthGroup[] = [];
	const blocks = yaml.split(/^\s*-\s+id:\s*/m).slice(1);
	for (const block of blocks) {
		const id = (block.split("\n")[0] ?? "").trim().replace(/^["']|["']$/g, "");
		const kind = /kind:\s*([A-Za-z]+)/.exec(block)?.[1] ?? "";
		const namespace = /namespace:\s*([a-z0-9-]+)/.exec(block)?.[1] ?? "";
		const filter = /filter:\s*\n\s*-\s*(.+)/.exec(block)?.[1]?.trim() ?? "";
		groups.push({
			id,
			kind,
			namespace,
			filter,
			rootCause: /root_cause:\s*true/.test(block),
		});
	}
	return groups;
}

const groups = parseGroups(groundTruth);
const rootGroup =
	groups.find((group) => group.rootCause && group.kind === "Deployment") ??
	groups[0];

function resolveGroupName(group: GroundTruthGroup): string | undefined {
	let pattern: RegExp | undefined;
	try {
		pattern = new RegExp(group.filter);
	} catch {
		pattern = undefined;
	}
	const names = namesOfKind(index, group.kind, group.namespace);
	return names.find((name) => (pattern === undefined ? true : pattern.test(name)));
}

const namespace = rootGroup?.namespace ?? "otel-demo";
const rootKind = rootGroup?.kind ?? "Deployment";
const rootGroupId = rootGroup?.id ?? "shipping-deployment-1";
const rootName = rootGroup === undefined ? undefined : resolveGroupName(rootGroup);
if (rootName === undefined) {
	throw new Error(`could not resolve ${rootKind} group ${rootGroupId} in ${namespace}`);
}
const condition =
	/fault:\s*\n(?:\s+-\s+entity:\n)?[\s\S]*?condition:\s*(.+)/.exec(groundTruth)?.[1]?.trim() ?? "";
const conditionTokens = tokens(condition);

const pods = namesOfKind(index, "Pod", namespace).filter((name) => /^shipping/.test(name));
const podName = pods[0];

const missing: string[] = [];
const bundle = await fetchKubernetesContext(
	{ client: kubernetesClient(index, events, missing), namespace, clusterId: "itbench-aa", now: () => 0 },
	{
		incidentFingerprint: `itbench-aa:scenario-16:${rootKind}:${rootName}`,
		namespace,
		kind: rootKind as "Deployment",
		name: rootName,
		...(podName === undefined ? {} : { podName }),
		includeLogs: false,
	},
);

const excerpts = bundle.items.map((item) => ({ kind: item.kind, excerpt: item.excerpt }));
const joined = excerpts.map((item) => item.excerpt).join("\n");
const entityRecall = joined.includes(rootName);
const conditionHits = conditionTokens.filter((token) => joined.includes(token));
// Prose words ("environment", "variable", "set") are not evidence; the tokens
// that carry the fault are identifiers, constants and numbers.
const decisiveTokens = conditionTokens.filter(
	(token) => /[0-9]/.test(token) || /^[A-Z0-9_]{3,}$/.test(token),
);
const decisiveHits = decisiveTokens.filter((token) => joined.includes(token));
const bytes = excerpts.reduce((total, item) => total + Buffer.byteLength(item.excerpt, "utf8"), 0);

const rerun = await fetchKubernetesContext(
	{ client: kubernetesClient(index, events, []), namespace, clusterId: "itbench-aa", now: () => 0 },
	{
		incidentFingerprint: `itbench-aa:scenario-16:${rootKind}:${rootName}`,
		namespace,
		kind: rootKind as "Deployment",
		name: rootName,
		...(podName === undefined ? {} : { podName }),
		includeLogs: false,
	},
);
const rerunDigest = digest(rerun.items.map((item) => ({ kind: item.kind, excerpt: item.excerpt })));

console.log(
	`scenario=itbench-aa/sre/Scenario-16 namespace=${namespace} groups=${groups.length}`,
);
console.log(
	`root=${rootGroupId} resolved=${rootKind}/${rootName} objects=${objects.length} events=${events.length} pods=${pods.length} pod=${podName ?? "none"}`,
);
console.log(`items=${bundle.items.length} kinds=${[...new Set(excerpts.map((i) => i.kind))].join(",")}`);
console.log(`truncated=${bundle.truncated} bytes=${bytes} approxTokens=${Math.ceil(bytes / 4)}`);
console.log(`entityRecall=${entityRecall ? 1 : 0} (${rootKind}/${rootName})`);
console.log(
	`conditionTokenRecall=${conditionTokens.length === 0 ? "n/a" : (conditionHits.length / conditionTokens.length).toFixed(2)} hits=${conditionHits.join(",") || "none"} of=${conditionTokens.join(",")}`,
);
console.log(
	`decisiveTokenRecall=${decisiveTokens.length === 0 ? "n/a" : (decisiveHits.length / decisiveTokens.length).toFixed(2)} hits=${decisiveHits.join(",") || "none"} of=${decisiveTokens.join(",")}`,
);
console.log(`digest=${digest(excerpts)} deterministic=${digest(excerpts) === rerunDigest}`);
console.log(`notServed=${[...new Set(missing.map((path) => path.replace(/namespaces\/[^/]+/, "namespaces/*")) )].join(",") || "none"}`);
