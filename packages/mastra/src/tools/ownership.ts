import { PlatformError } from "@isolate/shared";

/**
 * Bounded file-ownership matcher (wave 7).
 *
 * A task row carries `file_ownership`: relative POSIX glob patterns authored by
 * the task creator. The worker never lets the model widen that list — write and
 * commit tools consult this matcher before touching the sandbox. Globs are a
 * deliberately small subset: `*` matches within one path segment, `**` matches
 * across segments, `?` matches exactly one non-separator character, everything
 * else is literal.
 *
 * Absent or empty ownership means "no writes". Malformed patterns (absolute,
 * traversal, NUL, over-long, too many) are rejected with `VALIDATION_FAILED`
 * so a bad task row fails closed instead of silently dropping a grant.
 */

export const MAX_OWNERSHIP_PATTERNS = 200;
export const MAX_OWNERSHIP_PATH_LENGTH = 1024;

const NUL = "\u0000";
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//;

export type OwnershipMatcher = {
	/** True only when `path` normalizes to a relative path inside the patterns. */
	owns(path: string): boolean;
};

/**
 * Normalizes one path or pattern to a relative POSIX form. Returns `null` for
 * anything that must never be authorized: absolute paths, `..` traversal, NUL,
 * empty results, or inputs longer than 1024 characters.
 */
export function normalizeOwnershipPath(input: string): string | null {
	if (input.length === 0 || input.length > MAX_OWNERSHIP_PATH_LENGTH) {
		return null;
	}
	if (input.includes(NUL)) {
		return null;
	}
	// Windows-authored paths and patterns are normalized, not trusted verbatim.
	const unified = input.replaceAll("\\", "/");
	if (unified.startsWith("/") || WINDOWS_ABSOLUTE.test(unified)) {
		return null;
	}
	const segments: string[] = [];
	for (const segment of unified.split("/")) {
		if (segment === "" || segment === ".") {
			continue;
		}
		if (segment === "..") {
			return null;
		}
		segments.push(segment);
	}
	if (segments.length === 0) {
		return null;
	}
	return segments.join("/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Anchored glob-to-regexp conversion. A double star only spans segments when
 * it is a whole segment (a leading "double-star slash" prefix or a trailing
 * double star); a mixed run such as `a**b` stays inside one segment, matching
 * what a reviewer sees in the pattern.
 */
function globToRegExp(pattern: string): RegExp {
	let source = "^";
	let index = 0;
	while (index < pattern.length) {
		const char = pattern[index];
		if (char === "*") {
			const atSegmentStart = index === 0 || pattern[index - 1] === "/";
			if (pattern[index + 1] === "*") {
				if (atSegmentStart && pattern[index + 2] === "/") {
					// `**/` — zero or more whole segments.
					source += "(?:[^/]+/)*";
					index += 3;
					continue;
				}
				if (atSegmentStart && pattern[index + 2] === undefined) {
					// Trailing `**` — everything below the prefix.
					source += ".*";
					index += 2;
					continue;
				}
				source += "[^/]*";
				index += 2;
				continue;
			}
			source += "[^/]*";
			index += 1;
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			index += 1;
			continue;
		}
		source += escapeRegExp(char);
		index += 1;
	}
	return new RegExp(`${source}$`);
}

/**
 * Compiles a task's ownership list. Absent/empty yields a matcher that denies
 * every path. Throws a bounded `VALIDATION_FAILED` when the list itself is
 * outside the contract (too many entries, traversal, absolute, NUL, over-long).
 */
export function createOwnershipMatcher(
	patterns: readonly string[] | undefined,
): OwnershipMatcher {
	const list = patterns ?? [];
	if (list.length > MAX_OWNERSHIP_PATTERNS) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"too many file ownership patterns",
		);
	}
	const compiled: RegExp[] = [];
	for (const pattern of list) {
		const normalized = normalizeOwnershipPath(pattern);
		if (normalized === null) {
			// Bounded: the pattern value is never echoed into model context.
			throw new PlatformError(
				"VALIDATION_FAILED",
				"invalid file ownership pattern",
			);
		}
		compiled.push(globToRegExp(normalized));
	}
	return {
		owns(path: string): boolean {
			const normalized = normalizeOwnershipPath(path);
			if (normalized === null) {
				return false;
			}
			return compiled.some((regex) => regex.test(normalized));
		},
	};
}
