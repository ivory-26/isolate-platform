import { createFileRoute } from "@tanstack/react-router";
import type { IncidentIntakeFailureCode } from "../server/incident-intake.server";
import { getIncidentIntake } from "../server/incident-intake-runtime.server";
import {
	readBoundedWebhookBody,
	WEBHOOK_MAX_BODY_BYTES,
	WebhookBodyTooLargeError,
} from "../server/webhook-signature.server";

/**
 * Signed-webhook receiver (H12-4, wave 13).
 *
 * `server.handlers` only: no component, no client code, no secret in the
 * bundle. Mode selection (`x-github-event` → GitHub, otherwise generic),
 * verification, normalization, trigger policy, dedupe, the per-org cap and
 * submission all happen in `incident-intake.server`; this route only maps a
 * bounded result to a status. An accepted delivery is 202 with the task and
 * job ids; a replay is 202 `{deduped: true}`; a non-triggering event is 202
 * `{accepted: false}` and a capped one 202 `{accepted: false, throttled: true}`.
 * Nothing from the payload, the signature or the secret is echoed.
 */
export const Route = createFileRoute("/api/webhooks/$")({
	server: {
		handlers: {
			POST: ({ request }) => handleWebhookRequest(request),
		},
	},
});

const FAILURE_STATUS: Record<IncidentIntakeFailureCode, number> = {
	UNAUTHORIZED: 401,
	PAYLOAD_TOO_LARGE: 413,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	INVALID_INPUT: 400,
	CONFLICT: 409,
	UNAVAILABLE: 503,
};

const FAILURE_MESSAGE: Record<IncidentIntakeFailureCode, string> = {
	UNAUTHORIZED: "Signature verification failed.",
	PAYLOAD_TOO_LARGE: "The webhook payload is too large.",
	FORBIDDEN: "This webhook is not authorized for the bound organization.",
	NOT_FOUND: "No repository is bound to this webhook.",
	INVALID_INPUT: "The webhook payload is not a valid incident signal.",
	CONFLICT: "The incident could not be accepted as a new task.",
	UNAVAILABLE:
		"Webhook intake is not configured or is temporarily unavailable.",
};

function failure(
	status: number,
	message: string,
	headers: Record<string, string> = {},
): Response {
	return Response.json(
		{ error: message },
		{ status, headers: { "cache-control": "no-store", ...headers } },
	);
}

function reject(code: IncidentIntakeFailureCode): Response {
	return failure(FAILURE_STATUS[code], FAILURE_MESSAGE[code]);
}

async function handleWebhookRequest(request: Request): Promise<Response> {
	let intake: ReturnType<typeof getIncidentIntake>;
	try {
		intake = getIncidentIntake();
	} catch {
		// Missing secret or binding configuration fails closed, without detail.
		return failure(503, FAILURE_MESSAGE.UNAVAILABLE);
	}

	let rawBody: Uint8Array;
	try {
		rawBody = await readBoundedWebhookBody(request, WEBHOOK_MAX_BODY_BYTES);
	} catch (error) {
		return error instanceof WebhookBodyTooLargeError
			? reject("PAYLOAD_TOO_LARGE")
			: failure(400, FAILURE_MESSAGE.INVALID_INPUT);
	}

	let result: Awaited<ReturnType<typeof intake.acceptIncident>>;
	try {
		result = await intake.acceptIncident({
			rawBody,
			headers: request.headers,
		});
	} catch {
		return reject("UNAVAILABLE");
	}
	if (!result.ok) return reject(result.code);
	// A non-triggering, duplicate or throttled delivery creates nothing; only a
	// created (or live-replayed) task carries an id.
	if (!("taskId" in result)) {
		return Response.json(
			{
				...(result.deduped ? { deduped: true } : { accepted: false }),
				...(result.throttled ? { throttled: true } : {}),
			},
			{ status: 202, headers: { "cache-control": "no-store" } },
		);
	}
	return Response.json(
		{ taskId: result.taskId, jobId: result.jobId, deduped: result.deduped },
		{ status: 202, headers: { "cache-control": "no-store" } },
	);
}
