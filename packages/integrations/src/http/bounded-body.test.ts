import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	type BoundedJsonResult,
	type BoundedTextResult,
	readBoundedJson,
	readBoundedText,
} from "./bounded-body";

const encoder = new TextEncoder();

function bytes(...parts: string[]): Uint8Array[] {
	return parts.map((part) => encoder.encode(part));
}

type StreamHooks = {
	readonly onCancel?: () => void;
	readonly onPull?: () => void;
};

/** Pull-based fake so the reader controls exactly how much is produced. */
function streamResponse(
	chunks: Uint8Array[],
	hooks: StreamHooks = {},
): Response {
	let index = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const next = chunks[index];
				if (next === undefined) {
					controller.close();
					return;
				}
				index += 1;
				hooks.onPull?.();
				controller.enqueue(next);
			},
			cancel() {
				hooks.onCancel?.();
			},
		},
		{ highWaterMark: 0 },
	);
	return {
		body: stream,
		text: () => Promise.reject(new Error("streamed body must not call text()")),
	} as unknown as Response;
}

function textOnlyResponse(read: () => Promise<string>): Response {
	return { body: null, text: read } as unknown as Response;
}

function isTooLarge(result: BoundedTextResult): boolean {
	return !result.ok && result.reason === "too-large";
}

describe("readBoundedText", () => {
	test("reads a multi-chunk stream under the cap", async () => {
		const result = await readBoundedText(
			streamResponse(bytes("alpha", "beta", "gamma")),
			{ maxBytes: 64 },
		);
		expect(result).toEqual({ ok: true, text: "alphabetagamma", bytes: 14 });
	});

	test("accepts a body at exactly the cap", async () => {
		const result = await readBoundedText(
			streamResponse(bytes("1234", "567890")),
			{ maxBytes: 10 },
		);
		expect(result).toEqual({ ok: true, text: "1234567890", bytes: 10 });
	});

	test("cancels the reader as soon as a chunk would cross the cap", async () => {
		let cancelled = 0;
		let pulled = 0;
		const result = await readBoundedText(
			streamResponse(bytes("12345", "678901", "x".repeat(1024)), {
				onCancel: () => {
					cancelled += 1;
				},
				onPull: () => {
					pulled += 1;
				},
			}),
			{ maxBytes: 10 },
		);
		expect(isTooLarge(result)).toBe(true);
		expect(result).toEqual({
			ok: false,
			reason: "too-large",
			bytes: 11,
			truncated: true,
		});
		// The oversized chunk is counted but never decoded, and the remainder of
		// the stream is never pulled.
		expect(cancelled).toBe(1);
		expect(pulled).toBe(2);
	});

	test("decodes multi-byte characters split across chunks", async () => {
		const whole = encoder.encode("héllo ✓");
		const splitAt = 2;
		const result = await readBoundedText(
			streamResponse([whole.slice(0, splitAt), whole.slice(splitAt)]),
			{ maxBytes: 64 },
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text).toBe("héllo ✓");
	});

	test("returns an empty string for an empty stream", async () => {
		const result = await readBoundedText(streamResponse([]), { maxBytes: 16 });
		expect(result).toEqual({ ok: true, text: "", bytes: 0 });
	});

	test("falls back to text() when the response has no body stream", async () => {
		const result = await readBoundedText(
			textOnlyResponse(async () => "no-stream"),
			{ maxBytes: 16 },
		);
		expect(result).toEqual({ ok: true, text: "no-stream", bytes: 9 });
	});

	test("rejects a no-body text() result over the cap without truncating", async () => {
		const result = await readBoundedText(
			textOnlyResponse(async () => "éé"),
			{ maxBytes: 3 },
		);
		expect(result).toEqual({
			ok: false,
			reason: "too-large",
			bytes: 4,
			truncated: false,
		});
	});

	test("treats a text() failure as a fixed read failure", async () => {
		const result = await readBoundedText(
			textOnlyResponse(() => Promise.reject(new Error("provider secret"))),
			{ maxBytes: 16 },
		);
		expect(result).toEqual({
			ok: false,
			reason: "read-failed",
			bytes: 0,
			truncated: false,
		});
		expect(JSON.stringify(result)).not.toContain("provider secret");
	});

	test("keeps provider text out of oversized and failed results", async () => {
		const secret = "PROVIDER-BODY-SECRET-0123456789";
		const oversized = await readBoundedText(
			streamResponse(bytes("ok", secret)),
			{ maxBytes: 4 },
		);
		const failed = await readBoundedText(
			textOnlyResponse(() => Promise.reject(new Error(secret))),
			{ maxBytes: 64 },
		);
		expect(isTooLarge(oversized)).toBe(true);
		if (!oversized.ok) expect(oversized.truncated).toBe(true);
		expect(JSON.stringify(oversized)).not.toContain(secret);
		expect(JSON.stringify(failed)).not.toContain(secret);
	});

	test("refuses a non-positive or fractional cap", async () => {
		for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
			await expect(
				readBoundedText(streamResponse([]), { maxBytes }),
			).rejects.toBeInstanceOf(PlatformError);
		}
	});
});

describe("readBoundedJson", () => {
	test("parses a streamed JSON body under the cap", async () => {
		const result = await readBoundedJson(streamResponse(bytes('{"a":', "1}")), {
			maxBytes: 64,
		});
		expect(result).toEqual({ ok: true, data: { a: 1 }, bytes: 7 });
	});

	test("returns invalid-json without echoing the parse input", async () => {
		const secret = "not-json-provider-secret";
		const result = await readBoundedJson(
			streamResponse(bytes("not-json", "-provider-secret")),
			{ maxBytes: 64 },
		);
		const expected: BoundedJsonResult = {
			ok: false,
			reason: "invalid-json",
			bytes: 24,
			truncated: false,
		};
		expect(result).toEqual(expected);
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	test("returns invalid-json for an empty stream", async () => {
		const result = await readBoundedJson(streamResponse([]), { maxBytes: 8 });
		expect(result).toEqual({
			ok: false,
			reason: "invalid-json",
			bytes: 0,
			truncated: false,
		});
	});

	test("propagates the too-large failure from the text reader", async () => {
		let cancelled = false;
		const result = await readBoundedJson(
			streamResponse(bytes('{"secret":"', "PROVIDER-BODY-SECRET", '"}'), {
				onCancel: () => {
					cancelled = true;
				},
			}),
			{ maxBytes: 12 },
		);
		expect(result).toEqual({
			ok: false,
			reason: "too-large",
			bytes: 31,
			truncated: true,
		});
		expect(cancelled).toBe(true);
		expect(JSON.stringify(result)).not.toContain("PROVIDER-BODY-SECRET");
	});
});
