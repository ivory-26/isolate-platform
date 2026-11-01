import { createFileRoute } from "@tanstack/react-router";
import {
	type IncidentIntakeFailureCode,
	incidentFailureResponse,
} from "../server/incident-intake.server";
import { getIncidentIntake } from "../server/incident-intake-runtime.server";
import {
	readBoundedWebhookBody,
	WEBHOOK_MAX_BODY_BYTES,
	WebhookBodyTooLargeError,
} from "../server/webhook-signature.server";

/**
 * Signed-webhook receiver (H12-4, wave 13; adapter modes wave 17).
 *
 * `server.handlers` only: no component, no client code, no secret in the
 * bundle. Mode selection (`x-github-event` → GitHub, Sentry/Grafana/PagerDuty
 * header sets → their adapter, otherwise generic), verification,
 * normalization, trigger policy, dedupe, the per-org cap and submission all
 * happen in `incident-intake.server`; this route only maps a bounded result to
 * a status. An accepted delivery is 202 with the task and job ids; a replay is
 * 202 `{deduped: true}`; an adapter delivery that is not an incident (resolved,
 * non-production, wrong action) is 202 `{ignored: true}`; a non-triggering
 * GitHub event is 202 `{accepted: false}` and a capped one 202
 * `{accepted: false, throttled: true}`. Nothing from the payload, the signature
 * or the secret is echoed.
 */
export const Route = createFileRoute("/api/webhooks/$")({
	server: {
		handlers: {
			POST: ({ request }) => handleWebhookRequest(request),
		},
	},
});

/** Only the bounded failure projection lives outside the intake module. */
function reject(
	code: IncidentIntakeFailureCode,
	retryAfterSeconds?: number,
): Response {
	return incidentFailureResponse(code, retryAfterSeconds);
}

async function handleWebhookRequest(request: Request): Promise<Response> {
	let intake: ReturnType<typeof getIncidentIntake>;
	try {
		intake = getIncidentIntake();
	} catch {
		// Missing secret or binding configuration fails closed, without detail.
		return reject("UNAVAILABLE");
	}

	let rawBody: Uint8Array;
	try {
		rawBody = await readBoundedWebhookBody(request, WEBHOOK_MAX_BODY_BYTES);
	} catch (error) {
		return reject(
			error instanceof WebhookBodyTooLargeError
				? "PAYLOAD_TOO_LARGE"
				: "INVALID_INPUT",
		);
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
	if (!result.ok) return reject(result.code, result.retryAfterSeconds);
	// An adapter classified the delivery as "not an incident": no task exists.
	if ("accepted" in result && result.ignored === true) {
		return Response.json(
			{ ignored: true },
			{ status: 202, headers: { "cache-control": "no-store" } },
		);
	}
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
