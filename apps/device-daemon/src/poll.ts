import {
	claimedCalls,
	claimResponseSchema,
	DEVICE_MAX_RESULT_BYTES,
	type DeviceCall,
	type DeviceDispatcher,
	type DispatchOutcome,
	jsonByteLength,
} from "./contracts";
import { createConsoleLogger, type Logger } from "./logger";

/**
 * Long-poll loop against the device gateway.
 *
 * Contract (see `apps/web/src/server/device-gateway.server.ts`):
 * - `POST {serverUrl}/api/device/claim?limit=<n>` with
 *   `Authorization: Bearer <token>` returns `{ call: null }`, `{ call: {...} }`
 *   (single-call envelope) or `{ calls: [{ id, connectorId, credentialRef,
 *   toolName, params, deadlineAt }, ...] }` (batch envelope).
 * - `POST {serverUrl}/api/device/calls/{id}/result` returns the bounded
 *   `{ ok, data }` / `{ ok: false, errorCode }` envelope.
 *
 * Failure policy is deliberately asymmetric: 401/403 stop the daemon (a revoked
 * token must not spin), 5xx/network/429 back off exponentially with jitter up to
 * a hard ceiling, and any other status stops with a fixed message. The token,
 * params and provider result are never logged.
 */

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_BASE_BACKOFF_MS = 500;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_MAX_RESULT_ATTEMPTS = 3;
export const CLAIM_REQUEST_TIMEOUT_MS = 20_000;
export const RESULT_REQUEST_TIMEOUT_MS = 20_000;
/** A claim carries at most 16 KiB of params; anything larger is malformed. */
export const CLAIM_MAX_RESPONSE_BYTES = 64 * 1024;
/**
 * Calls requested per claim round. The gateway caps at ten; four keeps one
 * round's work below the claim deadline while still draining a burst queue.
 */
export const DEFAULT_CLAIM_BATCH_SIZE = 4;

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export type PollLoopOptions = {
	serverUrl: string;
	deviceToken: string;
	dispatch: DeviceDispatcher;
	fetchImpl?: typeof fetch;
	sleep?: Sleep;
	now?: () => number;
	random?: () => number;
	logger?: Logger;
	pollIntervalMs?: number;
	baseBackoffMs?: number;
	maxBackoffMs?: number;
	maxResultAttempts?: number;
	/** Calls requested per claim round (1–10, default 4). */
	claimBatchSize?: number;
	/** Optional bound; tests and one-shot runs stop after this many claims. */
	maxClaims?: number;
	signal?: AbortSignal;
};

export type PollLoopResult = {
	reason: "stopped" | "unauthorized" | "fatal";
	detail?: string;
};

function endpoint(serverUrl: string, path: string): string {
	return `${serverUrl.replace(/\/+$/, "")}${path}`;
}

const defaultSleep: Sleep = (ms, signal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted === true) {
			resolve();
			return;
		}
		const timer = setTimeout(finish, ms);
		const onAbort = (): void => finish();
		function finish(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/**
 * Exponential backoff with 50–100% jitter, bounded by `maxBackoffMs`.
 * `attempt` is 1-based: attempt 1 waits `baseBackoffMs` (times jitter).
 */
export function computeBackoffDelay(
	attempt: number,
	baseBackoffMs: number,
	maxBackoffMs: number,
	random: () => number,
): number {
	const safeAttempt = Math.min(Math.max(Math.trunc(attempt), 1), 30);
	const exponent = safeAttempt - 1;
	const raw = baseBackoffMs * 2 ** exponent;
	const capped = Math.min(maxBackoffMs, raw);
	const sample = Math.min(Math.max(random(), 0), 1);
	const jittered = Math.round(capped * (0.5 + sample * 0.5));
	return Math.min(maxBackoffMs, Math.max(0, jittered));
}

type ClaimOutcome =
	| { kind: "none" }
	| { kind: "calls"; calls: DeviceCall[] }
	| { kind: "retryable"; detail: string }
	| { kind: "unauthorized" }
	| { kind: "fatal"; detail: string };

type PollContext = {
	serverUrl: string;
	deviceToken: string;
	fetchImpl: typeof fetch;
	sleep: Sleep;
	now: () => number;
	random: () => number;
	logger: Logger;
	pollIntervalMs: number;
	baseBackoffMs: number;
	maxBackoffMs: number;
	maxResultAttempts: number;
	claimBatchSize: number;
	signal?: AbortSignal;
};

async function pause(context: PollContext, ms: number): Promise<void> {
	try {
		await context.sleep(ms, context.signal);
	} catch {
		// An aborted or failing sleep is only a request to check the signal.
	}
}

async function claimOnce(context: PollContext): Promise<ClaimOutcome> {
	let response: Response;
	try {
		response = await context.fetchImpl(
			endpoint(
				context.serverUrl,
				`/api/device/claim?limit=${context.claimBatchSize}`,
			),
			{
				method: "POST",
				headers: {
					accept: "application/json",
					authorization: `Bearer ${context.deviceToken}`,
				},
				signal: AbortSignal.timeout(CLAIM_REQUEST_TIMEOUT_MS),
			},
		);
	} catch {
		return { kind: "retryable", detail: "claim request failed" };
	}
	if (response.status === 401 || response.status === 403) {
		return { kind: "unauthorized" };
	}
	if (response.status === 429 || response.status >= 500) {
		return { kind: "retryable", detail: `claim status ${response.status}` };
	}
	if (response.status !== 200) {
		return { kind: "fatal", detail: `claim status ${response.status}` };
	}
	let text: string;
	try {
		text = await response.text();
	} catch {
		return { kind: "retryable", detail: "claim body could not be read" };
	}
	if (new TextEncoder().encode(text).byteLength > CLAIM_MAX_RESPONSE_BYTES) {
		return { kind: "retryable", detail: "claim body is too large" };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { kind: "retryable", detail: "claim body is not JSON" };
	}
	const parsed = claimResponseSchema.safeParse(raw);
	if (!parsed.success) {
		return { kind: "retryable", detail: "claim body is invalid" };
	}
	// One round may carry several calls; an empty envelope is "no work".
	const calls = claimedCalls(parsed.data);
	return calls.length === 0 ? { kind: "none" } : { kind: "calls", calls };
}

type ResultPostOutcome = "ok" | "unauthorized" | "failed";

function resultBody(result: DispatchOutcome):
	| {
			ok: true;
			data: Record<string, unknown>;
	  }
	| { ok: false; errorCode: string } {
	if (result.ok) {
		if (jsonByteLength(result.data) > DEVICE_MAX_RESULT_BYTES) {
			return { ok: false, errorCode: "VALIDATION_FAILED" };
		}
		return { ok: true, data: result.data };
	}
	return { ok: false, errorCode: result.errorCode };
}

async function postResult(
	context: PollContext,
	callId: string,
	result: DispatchOutcome,
): Promise<ResultPostOutcome> {
	const body = JSON.stringify(resultBody(result));
	const url = endpoint(
		context.serverUrl,
		`/api/device/calls/${encodeURIComponent(callId)}/result`,
	);
	for (let attempt = 1; attempt <= context.maxResultAttempts; attempt += 1) {
		let response: Response;
		try {
			response = await context.fetchImpl(url, {
				method: "POST",
				headers: {
					accept: "application/json",
					authorization: `Bearer ${context.deviceToken}`,
					"content-type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(RESULT_REQUEST_TIMEOUT_MS),
			});
		} catch {
			if (attempt < context.maxResultAttempts) {
				await pause(
					context,
					computeBackoffDelay(
						attempt,
						context.baseBackoffMs,
						context.maxBackoffMs,
						context.random,
					),
				);
			}
			continue;
		}
		if (response.status === 401 || response.status === 403) {
			return "unauthorized";
		}
		if (response.ok) return "ok";
		if (response.status < 500 && response.status !== 429) return "failed";
		if (attempt < context.maxResultAttempts) {
			await pause(
				context,
				computeBackoffDelay(
					attempt,
					context.baseBackoffMs,
					context.maxBackoffMs,
					context.random,
				),
			);
		}
	}
	return "failed";
}

async function executeCall(
	context: PollContext,
	call: DeviceCall,
	dispatch: DeviceDispatcher,
): Promise<ResultPostOutcome> {
	const startedAt = context.now();
	const deadlineMs = Date.parse(call.deadlineAt);
	let result: DispatchOutcome;
	if (Number.isFinite(deadlineMs) && deadlineMs <= startedAt) {
		result = { ok: false, errorCode: "INTEGRATION_UNAVAILABLE" };
	} else {
		try {
			result = await dispatch(call);
		} catch {
			result = { ok: false, errorCode: "INTERNAL" };
		}
	}
	const durationMs = Math.max(0, Math.round(context.now() - startedAt));
	const posted = await postResult(context, call.id, result);
	context.logger.info("connector call", {
		tool: call.toolName,
		connector: call.connectorId,
		outcome: result.ok ? "ok" : "error",
		durationMs,
	});
	return posted;
}

/** Runs until the token is rejected, a fatal status arrives, or aborted. */
export async function runPollLoop(
	options: PollLoopOptions,
): Promise<PollLoopResult> {
	const baseBackoffMs = Math.max(
		1,
		options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
	);
	const context: PollContext = {
		serverUrl: options.serverUrl,
		deviceToken: options.deviceToken,
		fetchImpl: options.fetchImpl ?? fetch,
		sleep: options.sleep ?? defaultSleep,
		now: options.now ?? (() => Date.now()),
		random: options.random ?? Math.random,
		logger: options.logger ?? createConsoleLogger(),
		pollIntervalMs: Math.max(
			0,
			options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
		),
		baseBackoffMs,
		maxBackoffMs: Math.max(
			baseBackoffMs,
			options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
		),
		maxResultAttempts: Math.max(
			1,
			options.maxResultAttempts ?? DEFAULT_MAX_RESULT_ATTEMPTS,
		),
		claimBatchSize: Math.min(
			10,
			Math.max(
				1,
				Math.trunc(options.claimBatchSize ?? DEFAULT_CLAIM_BATCH_SIZE),
			),
		),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	};
	const maxClaims = options.maxClaims ?? Number.POSITIVE_INFINITY;
	let claims = 0;
	let failures = 0;

	while (options.signal?.aborted !== true && claims < maxClaims) {
		claims += 1;
		const claim = await claimOnce(context);
		if (claim.kind === "unauthorized") {
			return { reason: "unauthorized", detail: "device authentication failed" };
		}
		if (claim.kind === "fatal") {
			return { reason: "fatal", detail: claim.detail };
		}
		if (claim.kind === "retryable") {
			failures += 1;
			const delay = computeBackoffDelay(
				failures,
				context.baseBackoffMs,
				context.maxBackoffMs,
				context.random,
			);
			context.logger.warn("claim retry", {
				attempt: failures,
				delayMs: delay,
			});
			await pause(context, delay);
			continue;
		}
		failures = 0;
		if (claim.kind === "none") {
			await pause(context, context.pollIntervalMs);
			continue;
		}
		// Strictly sequential: the device executes and posts one call at a time,
		// so provider rate limits and result retries stay bounded per round.
		for (const call of claim.calls) {
			const posted = await executeCall(context, call, options.dispatch);
			if (posted === "unauthorized") {
				return {
					reason: "unauthorized",
					detail: "device authentication failed",
				};
			}
		}
	}
	return { reason: "stopped" };
}
