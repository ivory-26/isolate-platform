import type { IncidentSeverity, OrganizationId } from "@isolate/shared";
import { INCIDENT_SEVERITIES } from "@isolate/shared";
import type { PgSql } from "../client";

/**
 * Tenant-scoped incident signal store (wave 13, migration 0009).
 *
 * A signal is the normalized identity of one inbound delivery (GitHub failed
 * run / failing check suite today). The table is deliberately narrow: no
 * payload, summary, log excerpt or credential is stored here — those belong to
 * the context bundle, which is assembled later and cited per item.
 *
 * Dedupe:
 * - `(organization_id, source, fingerprint, 30-minute bucket)` is unique in
 *   the database. `recordIfNew` inserts with `ON CONFLICT DO NOTHING`; when no
 *   row comes back it reads the surviving row by the same dedupe key, so two
 *   racing deliveries resolve to one signal id (`created: false`).
 * - The bucket is computed from `received_at` (not `now()`), so a replayed
 *   delivery with the same timestamp is a no-op while a genuinely later
 *   incident opens a new row.
 * - Every read filters on `organization_id` first: a foreign fingerprint is
 *   indistinguishable from a missing one.
 *
 * `countActiveIncidentTasks` backs the max-2 concurrent incident tasks cap:
 * it counts **non-terminal** tasks in the requested window that carry an
 * incident fingerprint and came from one of the requested sources. A failed or
 * completed incident must not consume the cap — otherwise two finished
 * incidents would block every new one until the window rolls over.
 */

export const INCIDENT_DEDUPE_WINDOW_SECONDS = 1800;
export const INCIDENT_DEDUPE_WINDOW_MS = INCIDENT_DEDUPE_WINDOW_SECONDS * 1000;
export const MAX_INCIDENT_SOURCE_CHARS = 32;
export const MAX_INCIDENT_KIND_CHARS = 64;
export const MAX_INCIDENT_SERVICE_CHARS = 128;
export const MAX_INCIDENT_FINGERPRINT_CHARS = 128;
export const MAX_INCIDENT_DELIVERY_ID_CHARS = 128;

export type IncidentSignalInput = {
	organizationId: OrganizationId;
	/** Bounded source token, e.g. `github`; the DB CHECK caps only length. */
	source: string;
	/** Event kind, e.g. `workflow_run.failed`. */
	kind: string;
	severity: IncidentSeverity;
	service: string;
	/** Source-stable dedupe key; never a delivery id. */
	fingerprint: string;
	/** Provider delivery id (GitHub `x-github-delivery`); audit only. */
	deliveryId?: string | null;
	/** Delivery time; defaults to the moment the intake calls the repository. */
	receivedAt?: Date;
};

export type NormalizedIncidentSignal = {
	organizationId: OrganizationId;
	source: string;
	kind: string;
	severity: IncidentSeverity;
	service: string;
	fingerprint: string;
	deliveryId: string | null;
	receivedAt: Date;
};

export type RecordIncidentSignalResult = {
	ok: true;
	signalId: string;
	/** false when the dedupe key (tenant, source, fingerprint, bucket) hit. */
	created: boolean;
};

export type CountActiveIncidentTasksInput = {
	organizationId: OrganizationId;
	/** Lower bound (inclusive) on `tasks.created_at`. */
	since: Date;
	/** Source tokens eligible for the cap; an empty list counts nothing. */
	sources: readonly string[];
};

export interface IncidentRepository {
	recordIfNew(input: IncidentSignalInput): Promise<RecordIncidentSignalResult>;
	countActiveIncidentTasks(
		input: CountActiveIncidentTasksInput,
	): Promise<number>;
}

/** Floor of `receivedAt` to the 30-minute dedupe bucket, in epoch ms. */
export function incidentDedupeBucketStart(receivedAt: Date): number {
	return (
		Math.floor(receivedAt.getTime() / INCIDENT_DEDUPE_WINDOW_MS) *
		INCIDENT_DEDUPE_WINDOW_MS
	);
}

function requireBoundedText(
	value: unknown,
	field: string,
	max: number,
): string {
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string`);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	if (trimmed.length > max) {
		throw new Error(`${field} must be at most ${max} characters`);
	}
	return trimmed;
}

/**
 * Validates and normalizes one signal for both the driver and the fake, so a
 * caller cannot persist a value the DB CHECK would reject (or the reverse).
 * Whitespace is trimmed; the fingerprint is otherwise preserved verbatim
 * because it is the dedupe identity.
 */
export function normalizeIncidentSignalInput(
	input: IncidentSignalInput,
): NormalizedIncidentSignal {
	if (
		typeof input.organizationId !== "string" ||
		input.organizationId.trim().length === 0
	) {
		throw new Error("organizationId must be a non-empty string");
	}
	const severity = input.severity;
	if (!INCIDENT_SEVERITIES.includes(severity)) {
		throw new Error(
			`severity must be one of ${INCIDENT_SEVERITIES.join(", ")}`,
		);
	}
	const receivedAt = input.receivedAt ?? new Date();
	if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
		throw new Error("receivedAt must be a valid Date");
	}
	const deliveryId =
		input.deliveryId === undefined || input.deliveryId === null
			? null
			: requireBoundedText(
					input.deliveryId,
					"deliveryId",
					MAX_INCIDENT_DELIVERY_ID_CHARS,
				);
	return {
		organizationId: input.organizationId,
		source: requireBoundedText(
			input.source,
			"source",
			MAX_INCIDENT_SOURCE_CHARS,
		),
		kind: requireBoundedText(input.kind, "kind", MAX_INCIDENT_KIND_CHARS),
		severity,
		service: requireBoundedText(
			input.service,
			"service",
			MAX_INCIDENT_SERVICE_CHARS,
		),
		fingerprint: requireBoundedText(
			input.fingerprint,
			"fingerprint",
			MAX_INCIDENT_FINGERPRINT_CHARS,
		),
		deliveryId,
		receivedAt: new Date(receivedAt.getTime()),
	};
}

export type IncidentMetadataInput = {
	incidentSource?: string | null;
	incidentFingerprint?: string | null;
};

export type NormalizedIncidentMetadata = {
	incidentSource: string | null;
	incidentFingerprint: string | null;
};

/**
 * Bounds the incident provenance a task row may carry. Source and fingerprint
 * travel as a pair: a fingerprint without a source cannot be attributed to the
 * cap, and a source without a fingerprint cannot be deduped, so half a pair is
 * a caller bug rather than a silently nullable field.
 */
export function normalizeIncidentMetadata(
	input: IncidentMetadataInput,
): NormalizedIncidentMetadata {
	const source = input.incidentSource ?? null;
	const fingerprint = input.incidentFingerprint ?? null;
	if (source === null && fingerprint === null) {
		return { incidentSource: null, incidentFingerprint: null };
	}
	if (source === null || fingerprint === null) {
		throw new Error(
			"incidentSource and incidentFingerprint must be provided together",
		);
	}
	return {
		incidentSource: requireBoundedText(
			source,
			"incidentSource",
			MAX_INCIDENT_SOURCE_CHARS,
		),
		incidentFingerprint: requireBoundedText(
			fingerprint,
			"incidentFingerprint",
			MAX_INCIDENT_FINGERPRINT_CHARS,
		),
	};
}

/**
 * Bounds the source list used by the cap query. Shared by the driver and the
 * fake so an invalid token fails in both, not only in Postgres.
 */
export function normalizeIncidentSources(sources: readonly string[]): string[] {
	if (!Array.isArray(sources)) {
		throw new Error("sources must be an array of source tokens");
	}
	return sources.map((source) =>
		requireBoundedText(source, "source", MAX_INCIDENT_SOURCE_CHARS),
	);
}

const STMT = {
	// The unique index is expression-based, so the conflict target is omitted:
	// `DO NOTHING` covers any unique violation and there is exactly one.
	insert: `INSERT INTO incident_signals (
		organization_id, source, kind, severity, service, fingerprint,
		delivery_id, received_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
	ON CONFLICT DO NOTHING
	RETURNING id`,
	// Same dedupe key as the index: tenant, source, fingerprint and bucket.
	findByDedupeKey: `SELECT id FROM incident_signals
		WHERE organization_id = $1
		  AND source = $2
		  AND fingerprint = $3
		  AND floor(extract(epoch from received_at) / ${INCIDENT_DEDUPE_WINDOW_SECONDS})
		      = floor(extract(epoch from $4::timestamptz) / ${INCIDENT_DEDUPE_WINDOW_SECONDS})
		ORDER BY received_at DESC
		LIMIT 1`,
	countActive: `SELECT count(*)::int AS n FROM tasks
		WHERE organization_id = $1
		  AND incident_fingerprint IS NOT NULL
		  AND incident_source = ANY($2::text[])
		  AND created_at >= $3::timestamptz
		  AND status NOT IN ('completed', 'failed', 'cancelled', 'blocked')`,
} as const;

export class PostgresIncidentRepository implements IncidentRepository {
	constructor(private readonly sql: PgSql) {}

	async recordIfNew(
		input: IncidentSignalInput,
	): Promise<RecordIncidentSignalResult> {
		const signal = normalizeIncidentSignalInput(input);
		// Timestamps are bound as explicit ISO-8601 text under a `::timestamptz`
		// cast (never rely on the driver's Date coercion under a cast; see the
		// jsonb double-encoding lesson in CHALLENGES).
		const receivedAt = signal.receivedAt.toISOString();
		const inserted = (await this.sql.unsafe(STMT.insert, [
			signal.organizationId,
			signal.source,
			signal.kind,
			signal.severity,
			signal.service,
			signal.fingerprint,
			signal.deliveryId,
			receivedAt,
		])) as unknown as Record<string, unknown>[];
		if (inserted.length > 0) {
			return { ok: true, signalId: String(inserted[0].id), created: true };
		}
		// Dedupe hit (possibly a concurrent insert): read the surviving row by
		// the same key instead of failing or creating a second signal.
		const existing = (await this.sql.unsafe(STMT.findByDedupeKey, [
			signal.organizationId,
			signal.source,
			signal.fingerprint,
			receivedAt,
		])) as unknown as Record<string, unknown>[];
		if (existing.length === 0) {
			throw new Error(
				"incident signal insert conflicted but no row matches the dedupe key",
			);
		}
		return { ok: true, signalId: String(existing[0].id), created: false };
	}

	async countActiveIncidentTasks(
		input: CountActiveIncidentTasksInput,
	): Promise<number> {
		if (
			typeof input.organizationId !== "string" ||
			input.organizationId.trim().length === 0
		) {
			throw new Error("organizationId must be a non-empty string");
		}
		if (!(input.since instanceof Date) || Number.isNaN(input.since.getTime())) {
			throw new Error("since must be a valid Date");
		}
		const sources = normalizeIncidentSources(input.sources);
		// `= ANY('{}')` is always false, but skipping the round trip keeps the
		// empty-list case obvious to callers and tests.
		if (sources.length === 0) return 0;
		const rows = (await this.sql.unsafe(STMT.countActive, [
			input.organizationId,
			sources,
			input.since,
		])) as unknown as Record<string, unknown>[];
		return Number(rows[0]?.n ?? 0);
	}
}
