import {
	type ConnectorIncidentRef,
	KUBERNETES_OBJECT_KINDS,
	type KubernetesObjectKind,
	parseConnectorIncidentFingerprint,
} from "@isolate/integrations";
import type { ToolParams } from "../contracts";

/**
 * Shared parsing for the nine non-GitHub `*.context.fetch` device tools.
 *
 * The server only ever sends a connector incident fingerprint (never a raw
 * webhook body) plus optional display selectors. The fingerprint is parsed
 * strictly here; anything malformed or belonging to another source fails
 * `VALIDATION_FAILED` **before** an adapter dependency is built, so no
 * provider call and no secret use can happen for an untrusted selector.
 */

export type ContextParams = Readonly<{
	incidentFingerprint: string;
	service?: string;
	kind?: string;
}>;

function optionalString(
	value: unknown,
): { ok: true; value: string | undefined } | { ok: false } {
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== "string" || value.trim().length === 0) {
		return { ok: false };
	}
	return { ok: true, value };
}

/** Reads the closed context-call parameter shape; extras are ignored. */
export function readContextParams(params: ToolParams): ContextParams | null {
	const fingerprint = params.incidentFingerprint;
	if (typeof fingerprint !== "string") return null;
	const service = optionalString(params.service);
	const kind = optionalString(params.kind);
	if (!service.ok || !kind.ok) return null;
	return {
		incidentFingerprint: fingerprint,
		...(service.value === undefined ? {} : { service: service.value }),
		...(kind.value === undefined ? {} : { kind: kind.value }),
	};
}

/**
 * Parses a fingerprint and requires it to belong to `source`. A fingerprint
 * for another connector is treated exactly like a malformed one.
 */
export function parseContextFingerprint<
	TSource extends ConnectorIncidentRef["source"],
>(
	fingerprint: string,
	source: TSource,
): Extract<ConnectorIncidentRef, { source: TSource }> | null {
	const parsed = parseConnectorIncidentFingerprint(fingerprint);
	if (parsed === null || parsed.source !== source) return null;
	return parsed as Extract<ConnectorIncidentRef, { source: TSource }>;
}

/** Non-empty (trimmed) service selector, or `null` when it is required. */
export function requiredService(params: ContextParams): string | null {
	const service = params.service?.trim();
	return service !== undefined && service.length > 0 ? service : null;
}

/**
 * Maps a fingerprint or parameter kind onto the adapter's enum. Fingerprints
 * carry the lowercased involved-object kind (`pod`), the adapter accepts the
 * canonical `Pod`; both are the same selector.
 */
export function canonicalKubernetesKind(
	value: string,
): KubernetesObjectKind | null {
	const lowered = value.toLowerCase();
	return (
		KUBERNETES_OBJECT_KINDS.find(
			(candidate) => candidate.toLowerCase() === lowered,
		) ?? null
	);
}
