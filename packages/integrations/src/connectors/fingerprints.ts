/**
 * Connector incident fingerprint parsing (wave 19).
 *
 * Each adapter builds a source-stable fingerprint at normalization time. The
 * device-side context loader must turn that back into provider selectors
 * without ever seeing the raw webhook body. Parsing is strict and bounded:
 * a malformed or over-long fingerprint yields `null` (no context) rather than
 * a best-effort guess.
 */

export type ConnectorIncidentRef =
	| {
			readonly source: "sentry";
			readonly orgSlug: string;
			readonly project: string;
			readonly issueId: string;
	  }
	| { readonly source: "grafana"; readonly ruleUid: string }
	| {
			readonly source: "pagerduty";
			readonly serviceId: string;
			readonly incidentId: string;
	  }
	| {
			readonly source: "kubernetes";
			readonly cluster: string;
			readonly namespace: string;
			readonly kind: string;
			readonly name: string;
			readonly reason: string;
	  }
	| { readonly source: "datadog"; readonly monitorId: string }
	| { readonly source: "newrelic"; readonly digest: string }
	| {
			readonly source: "honeycomb";
			readonly dataset: string;
			readonly triggerId: string;
			readonly state: string;
	  }
	| { readonly source: "axiom"; readonly monitorId: string }
	| { readonly source: "signoz"; readonly ruleId: string };

const MAX_SEGMENT_CHARS = 64;
const SEGMENT_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/;

function segment(value: string | undefined): string | null {
	if (value === undefined) return null;
	if (value.length === 0 || value.length > MAX_SEGMENT_CHARS) return null;
	return SEGMENT_PATTERN.test(value) ? value : null;
}

/**
 * Parses the fingerprint shapes produced by the ten adapters. GitHub
 * fingerprints are handled by the existing GitHub context reader and return
 * `null` here.
 */
export function parseConnectorIncidentFingerprint(
	fingerprint: string,
): ConnectorIncidentRef | null {
	if (typeof fingerprint !== "string" || fingerprint.length > 128) return null;
	const parts = fingerprint.split(":");
	const source = parts[0];
	switch (source) {
		case "sentry": {
			const orgSlug = segment(parts[1]);
			const project = segment(parts[2]);
			const issueId = segment(parts[3]);
			return orgSlug !== null && project !== null && issueId !== null
				? { source: "sentry", orgSlug, project, issueId }
				: null;
		}
		case "grafana": {
			const ruleUid = segment(parts[1]);
			return ruleUid !== null ? { source: "grafana", ruleUid } : null;
		}
		case "pagerduty": {
			const serviceId = segment(parts[1]);
			const incidentId = segment(parts[2]);
			return serviceId !== null && incidentId !== null
				? { source: "pagerduty", serviceId, incidentId }
				: null;
		}
		case "k8s": {
			const cluster = segment(parts[1]);
			const namespace = segment(parts[2]);
			const kindName = parts[3]?.split("/");
			const reason = segment(parts[4]);
			const kind = segment(kindName?.[0]);
			const name = segment(kindName?.[1]);
			return cluster !== null &&
				namespace !== null &&
				kind !== null &&
				name !== null &&
				reason !== null
				? { source: "kubernetes", cluster, namespace, kind, name, reason }
				: null;
		}
		case "datadog": {
			const monitorId = segment(parts[1]);
			return monitorId !== null ? { source: "datadog", monitorId } : null;
		}
		case "newrelic": {
			const digest = segment(parts[1]);
			return digest !== null ? { source: "newrelic", digest } : null;
		}
		case "honeycomb": {
			const dataset = segment(parts[1]);
			const triggerId = segment(parts[2]);
			const state = segment(parts[3]);
			return dataset !== null && triggerId !== null && state !== null
				? { source: "honeycomb", dataset, triggerId, state }
				: null;
		}
		case "axiom": {
			const monitorId = segment(parts[1]);
			return monitorId !== null ? { source: "axiom", monitorId } : null;
		}
		case "signoz": {
			const ruleId = segment(parts[1]);
			return ruleId !== null ? { source: "signoz", ruleId } : null;
		}
		default:
			return null;
	}
}
