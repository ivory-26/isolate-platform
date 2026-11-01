import { PlatformError } from "@isolate/shared";

/**
 * Bounded, chunked response-body reader shared by every provider adapter.
 *
 * Provider response bodies are attacker-influenced (a compromised or buggy
 * endpoint controls both the payload and `Content-Length`), so a body is never
 * buffered first and measured afterwards. When the response exposes a body
 * stream the reader pulls chunk by chunk, counts raw bytes, and cancels the
 * reader the moment the next chunk would cross the cap. The fallback path for
 * responses without a stream still measures the decoded text before accepting
 * it.
 *
 * Results are typed and fixed: no provider text, headers, URL or credential
 * ever appears in a failure. Adapters translate the fixed `reason` into their
 * own existing outcome vocabulary (`skipped`, `failed`, `denied`, ...).
 */

export type BoundedBodyFailureReason =
	| "too-large"
	| "read-failed"
	| "invalid-json";

export type BoundedTextResult =
	| { readonly ok: true; readonly text: string; readonly bytes: number }
	| {
			readonly ok: false;
			readonly reason: "too-large" | "read-failed";
			readonly bytes: number;
			/** True only when a streamed body was abandoned at the cap. */
			readonly truncated: boolean;
	  };

export type BoundedJsonResult =
	| { readonly ok: true; readonly data: unknown; readonly bytes: number }
	| {
			readonly ok: false;
			readonly reason: BoundedBodyFailureReason;
			readonly bytes: number;
			readonly truncated: boolean;
	  };

export type BoundedBodyOptions = {
	/** Maximum accepted body size in UTF-8 bytes; must be a positive integer. */
	readonly maxBytes: number;
};

const encoder = new TextEncoder();

function assertCap(options: BoundedBodyOptions): number {
	const maxBytes = options.maxBytes;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new PlatformError("INTERNAL", "bounded body cap is invalid");
	}
	return maxBytes;
}

/** Structural reader shape: the DOM and Node stream typings disagree on extras. */
type CancellableReader = { cancel(reason?: unknown): Promise<void> };

async function cancelQuietly(reader: CancellableReader): Promise<void> {
	try {
		await reader.cancel();
	} catch {
		// The stream may already be closed or errored; cancellation is best effort.
	}
}

/**
 * Reads a response body under `maxBytes`.
 *
 * - Streamed body: chunks are decoded incrementally; the first chunk that
 *   would push the total past the cap cancels the reader and returns
 *   `{ok:false, reason:"too-large", truncated:true}` without buffering the
 *   rest of the payload.
 * - No body stream: falls back to `response.text()` and rejects (does not
 *   truncate) when the decoded text exceeds the cap.
 * - Never throws for provider behavior: read failures become `read-failed`.
 */
export async function readBoundedText(
	response: Response,
	options: BoundedBodyOptions,
): Promise<BoundedTextResult> {
	const maxBytes = assertCap(options);
	const body = response.body;
	if (body !== null && typeof body.getReader === "function") {
		const reader = body.getReader();
		// Per-call decoder: streaming state must not leak between concurrent reads.
		const decoder = new TextDecoder();
		let bytes = 0;
		let text = "";
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				const value = chunk.value;
				if (value === undefined) continue;
				bytes += value.byteLength;
				if (bytes > maxBytes) {
					await cancelQuietly(reader);
					return { ok: false, reason: "too-large", bytes, truncated: true };
				}
				text += decoder.decode(value, { stream: true });
			}
			text += decoder.decode();
			return { ok: true, text, bytes };
		} catch {
			return { ok: false, reason: "read-failed", bytes, truncated: false };
		} finally {
			reader.releaseLock();
		}
	}

	let text: string;
	try {
		text = await response.text();
	} catch {
		return { ok: false, reason: "read-failed", bytes: 0, truncated: false };
	}
	const bytes = encoder.encode(text).byteLength;
	if (bytes > maxBytes) {
		return { ok: false, reason: "too-large", bytes, truncated: false };
	}
	return { ok: true, text, bytes };
}

/**
 * Bounded text read followed by `JSON.parse`. Parse input is never echoed:
 * malformed or oversized bodies collapse to fixed reasons.
 */
export async function readBoundedJson(
	response: Response,
	options: BoundedBodyOptions,
): Promise<BoundedJsonResult> {
	const read = await readBoundedText(response, options);
	if (!read.ok) return read;
	try {
		return { ok: true, data: JSON.parse(read.text), bytes: read.bytes };
	} catch {
		return {
			ok: false,
			reason: "invalid-json",
			bytes: read.bytes,
			truncated: false,
		};
	}
}
