import { PlatformError } from "../types/errors";

/**
 * Recursive credential-material scan for server-boundary payloads.
 *
 * The invariant (ARCHITECTURE.md §11) is absolute: no provider key, token,
 * Authorization header, private key or password is ever persisted or forwarded
 * server-side. This module is the single shared detector used by every
 * boundary that accepts untrusted JSON-ish data (queue params/results,
 * credential metadata/refs, tool arguments).
 *
 * Two independent checks run per node:
 * - key names are matched as whole normalized segments, so `authorization`,
 *   `api_key`, `apiKey` or `client-secret` are refused while ordinary metadata
 *   such as `tokenCount`, `tokenBudget` or `expiresAt` passes;
 * - string values are matched against well-known credential shapes.
 *
 * Traversal is depth-capped (default 6) and cycle-safe. Results never echo the
 * offending value; `assertNoCredentialMaterial` throws one fixed message.
 */

/** Default and hard traversal cap for a scan. */
export const MAX_CREDENTIAL_SCAN_DEPTH = 6;

/** Absolute ceiling for an explicitly requested depth, to bound the walk. */
const HARD_MAX_SCAN_DEPTH = 12;

export type CredentialMaterialReason =
	| "credential-shaped key"
	| "credential-shaped value";

export type CredentialMaterialHit = {
	/** Dot/bracket path of the hit, e.g. `$.headers.authorization`. */
	path: string;
	reason: CredentialMaterialReason;
};

export type CredentialScanOptions = {
	/** Traversal cap, clamped to 0..12. Defaults to 6. */
	maxDepth?: number;
};

/**
 * Sensitive key names after normalization (lowercase, `-`/`_` removed). The
 * set deliberately contains only whole names: `token` is refused, `tokenCount`
 * is not, because the normalized whole key differs.
 */
const DENYLIST_KEY_SEGMENTS: ReadonlySet<string> = new Set([
	"authorization",
	"apikey",
	"accesstoken",
	"refreshtoken",
	"clientsecret",
	"privatekey",
	"secret",
	"password",
	"bearer",
	"token",
	// Carried over from the previous shallow worker check: session cookies and
	// long-lived access keys are the same class of material.
	"cookie",
	"sessionid",
	"accesskey",
]);

/**
 * Credential shapes refused inside string values. `sk-` covers OpenAI/Anthropic
 * style keys, which are the most common thing a model might paste into a tool
 * argument or a device result.
 */
const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
	/\bxox[bp]-[A-Za-z0-9-]{10,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
	/\bBearer\s+\S{8,}/,
	/\beyJ[A-Za-z0-9_-]{20,}\./,
	/\bsk-[A-Za-z0-9_-]{16,}\b/,
];

function normalizeSegment(segment: string): string {
	return segment.toLowerCase().replace(/[_-]/g, "");
}

/**
 * True when a key is credential-shaped. The whole key and each
 * non-alphanumeric-delimited part are compared to the denylist, so `apiKey`,
 * `api_key` and `api-key` all match while `tokenCount` does not.
 */
export function isCredentialMaterialKey(key: string): boolean {
	if (typeof key !== "string") return false;
	const lowered = key.toLowerCase();
	if (DENYLIST_KEY_SEGMENTS.has(normalizeSegment(lowered))) return true;
	for (const part of lowered.split(/[^a-z0-9]+/)) {
		if (part.length === 0) continue;
		if (DENYLIST_KEY_SEGMENTS.has(normalizeSegment(part))) return true;
	}
	return false;
}

function isCredentialMaterialValue(value: string): boolean {
	for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
		if (pattern.test(value)) return true;
	}
	return false;
}

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function childPath(path: string, key: string): string {
	return `${path}.${key}`;
}

/**
 * Walks objects and arrays to `maxDepth` and returns the first credential hit
 * in traversal order, or `null`. Non-plain objects (Date, Map, class
 * instances) are not traversed: they are not JSON boundary payloads.
 */
export function findCredentialMaterial(
	value: unknown,
	options: CredentialScanOptions = {},
): CredentialMaterialHit | null {
	const requested = options.maxDepth ?? MAX_CREDENTIAL_SCAN_DEPTH;
	const maxDepth = Math.min(
		Math.max(Math.trunc(requested), 0),
		HARD_MAX_SCAN_DEPTH,
	);

	const walk = (
		node: unknown,
		depth: number,
		path: string,
		seen: WeakSet<object>,
	): CredentialMaterialHit | null => {
		if (typeof node === "string") {
			return isCredentialMaterialValue(node)
				? { path, reason: "credential-shaped value" }
				: null;
		}
		if (node === null || typeof node !== "object") return null;
		if (depth > maxDepth) return null;
		if (!Array.isArray(node) && !isPlainObject(node)) return null;
		if (seen.has(node)) return null;
		seen.add(node);

		if (Array.isArray(node)) {
			for (let index = 0; index < node.length; index += 1) {
				const hit = walk(node[index], depth + 1, `${path}[${index}]`, seen);
				if (hit !== null) return hit;
			}
			seen.delete(node);
			return null;
		}

		for (const [key, child] of Object.entries(node)) {
			if (isCredentialMaterialKey(key)) {
				return {
					path: childPath(path, key),
					reason: "credential-shaped key",
				};
			}
			const hit = walk(child, depth + 1, childPath(path, key), seen);
			if (hit !== null) return hit;
		}
		seen.delete(node);
		return null;
	};

	return walk(value, 0, "$", new WeakSet());
}

/**
 * Throws a fixed, value-free `VALIDATION_FAILED` when the payload carries
 * credential material anywhere within the scanned depth.
 *
 * A boundary whose own JSON cap admits more than six levels should pass a
 * matching `maxDepth`, so the scan cannot be outrun by extra nesting.
 */
export function assertNoCredentialMaterial(
	value: unknown,
	options: CredentialScanOptions = {},
): void {
	if (findCredentialMaterial(value, options) !== null) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"credential material is not allowed",
		);
	}
}
