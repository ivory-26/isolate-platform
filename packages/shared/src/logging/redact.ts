/**
 * Deep redaction for logging and audit payload hygiene.
 *
 * Complements `redactFields` (shallow, console-logger layer): this walks
 * arbitrary JSON-ish payloads, replacing anything that is not expressible as
 * plain serialisable data with a inert type marker, and replacing values under
 * sensitive keys with `[redacted]`.
 *
 * Guarantees:
 * - traversal depth is capped (default and maximum: 6); deeper containers
 *   collapse to `[truncated]`
 * - non-plain values (class instances, Date, Map, Set, RegExp, functions,
 *   symbols) never survive: they become `[TypeName]` markers
 * - cycles never recurse forever: revisited references become `[circular]`
 * - array traversal is element-capped so one field cannot fan out the payload
 * - the returned object is JSON-safe (bigints become strings)
 *
 * Redaction is key-based; a secret stored under a non-sensitive key is still
 * the caller's responsibility (see ARCHITECTURE.md §11).
 */

export const REDACTED = "[redacted]";
export const REDACT_CIRCULAR = "[circular]";
export const REDACT_TRUNCATED = "[truncated]";

/** Hard cap on traversal depth for log/audit payloads. */
export const MAX_REDACT_DEPTH = 6;

/** Maximum array elements walked per array before the tail is elided. */
const ARRAY_ELEMENT_CAP = 100;

/**
 * Sensitive key matcher. Kept in sync with the console-logger matcher; shared
 * here so audit redaction and log redaction cannot drift apart.
 */
export const SENSITIVE_KEY_PATTERN =
	/api[-_]?key|token|secret|password|authorization|cookie|database[-_]?url|connection[-_]?string|credential/i;

export interface RedactDeepOptions {
	/** Traversal cap, clamped to 0..MAX_REDACT_DEPTH. Defaults to the max. */
	maxDepth?: number;
}

export interface RedactDeepResult {
	/** Redaction-safe, JSON-serialisable copy of the input value. */
	output: unknown;
	/** Dot paths whose values were replaced by `REDACTED`, e.g. `config.apiKey`. */
	redacted: string[];
}

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Inert marker describing an object that is not a plain object or array. */
function markerFor(value: object): string {
	const ctor = (value as { constructor?: { name?: string } }).constructor;
	return `[${ctor?.name ?? Object.prototype.toString.call(value).slice(8, -1)}]`;
}

/**
 * Walks a plain-object payload and returns a redacted, depth-capped copy.
 * Primitives always survive (they cannot be traversed further); container
 * values beyond the depth cap are replaced by `REDACT_TRUNCATED`.
 */
export function redactDeep(
	value: unknown,
	options: RedactDeepOptions = {},
): RedactDeepResult {
	const requestedDepth = options.maxDepth ?? MAX_REDACT_DEPTH;
	const maxDepth = Math.min(
		Math.max(Math.trunc(requestedDepth), 0),
		MAX_REDACT_DEPTH,
	);
	const redacted: string[] = [];

	const walk = (
		node: unknown,
		depth: number,
		path: string,
		seen: WeakSet<object>,
	): unknown => {
		if (node === null) {
			return null;
		}
		switch (typeof node) {
			case "string":
			case "number":
			case "boolean":
			case "undefined":
				return node;
			case "bigint":
				return node.toString();
			case "symbol":
				return "[symbol]";
			case "function":
				return "[function]";
		}

		const obj = node as object;
		if (!Array.isArray(obj) && !isPlainObject(obj)) {
			return markerFor(obj);
		}
		if (seen.has(obj)) {
			return REDACT_CIRCULAR;
		}
		if (depth > maxDepth) {
			return REDACT_TRUNCATED;
		}
		seen.add(obj);

		if (Array.isArray(obj)) {
			const out: unknown[] = [];
			for (let index = 0; index < obj.length; index += 1) {
				if (index >= ARRAY_ELEMENT_CAP) {
					out.push(REDACT_TRUNCATED);
					break;
				}
				out.push(walk(obj[index], depth + 1, `${path}[${index}]`, seen));
			}
			seen.delete(obj);
			return out;
		}

		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(obj)) {
			const childPath = path.length > 0 ? `${path}.${key}` : key;
			if (SENSITIVE_KEY_PATTERN.test(key)) {
				redacted.push(childPath);
				out[key] = REDACTED;
				continue;
			}
			out[key] = walk(child, depth + 1, childPath, seen);
		}
		seen.delete(obj);
		return out;
	};

	return {
		output: walk(value, 0, "", new WeakSet()),
		redacted,
	};
}
