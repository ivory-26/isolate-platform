import type { OrganizationId, RepositoryId } from "@isolate/shared";
import type { PgSql } from "../client";

/**
 * Row-lease branch lock for one (organization, repository, branch) triple.
 *
 * The worker takes this lock before provisioning a sandbox and releases it in
 * `finally`, so two jobs can never mutate the same branch concurrently.
 *
 * WHY A ROW, NOT A SESSION ADVISORY LOCK
 * The production URL is Neon's pooled endpoint (PgBouncer, transaction mode).
 * A session-scoped `pg_try_advisory_lock` lives on one BACKEND session; the
 * pooler is free to route the next statement - including the unlock - to a
 * different backend. The lock can then leak (unlock miss) or be granted twice
 * (acquire on a second backend), which is exactly the "two writers on one
 * branch" failure the lock exists to prevent. Pinning a connection does not
 * fix it: the pooler owns backend assignment, not the client handle.
 *
 * This implementation keeps the lease in `branch_locks` (migration 0007) and
 * holds NO session state:
 *
 * - `acquire` is ONE statement: an INSERT ... ON CONFLICT DO UPDATE that only
 *   overwrites a row whose lease already expired, RETURNING the owner id. A
 *   returned row equal to our freshly generated owner id means we hold the
 *   lease; no row means another owner's lease is live (`LOCKED`).
 * - `renew` is ONE UPDATE guarded by `owner_id` that pushes `expires_at` out
 *   by a fresh TTL and RETURNS the row. A row proves the same owner still
 *   holds the lease; no row means the lease expired and was taken over (or
 *   released) and is reported as `LOST`, never retried into a second writer.
 * - `release` is ONE DELETE guarded by `owner_id`, so a lease that expired and
 *   was handed to another owner is never deleted by the previous holder.
 *   Release is idempotent: a second call deletes zero rows and succeeds.
 * - Every statement is an independent autocommit statement with no BEGIN,
 *   `prepare` names, `LISTEN`, `SET` or temp objects, so transaction pooling
 *   may route each one anywhere without changing the outcome.
 * - If a client dies mid-acquire the statement either committed (the row
 *   expires after `ttlMs`) or did not run; there is nothing to leak and no
 *   session state to clean up.
 *
 * LEASE BOUNDS
 * `ttlMs` must be an integer in [5 s, 1 h], default 15 min; out-of-range
 * values are rejected, never silently clamped. The lease MUST outlive the
 * job that protects it: a worker that runs past its lease can be taken over by
 * another worker. Callers with long jobs pass an explicit `ttlMs` and keep the
 * lease alive with `renew` on their heartbeat schedule rather than relying on
 * the default. Expired rows are reclaimed lazily by the next acquire for the
 * same triple; the `branch_locks_expires_at_idx` index supports an explicit
 * sweep later.
 *
 * Keys are normalized by `evaluateBranchLockKey`; the row stores the same
 * normalized organization/repository UUIDs and the verbatim branch, so the
 * pure helper remains the single definition of a valid triple. The migration
 * CHECK bounds the branch length at 255, matching the helper.
 */

/** Longest accepted branch name; mirrors the 0006 retry-branch clamp. */
export const MAX_BRANCH_LOCK_BRANCH_LENGTH = 255;

/**
 * Longest composite key produced by `evaluateBranchLockKey`: two 36-char
 * UUIDs, two separators and a 255-char branch = 329 characters. 512 is a hard
 * cap with headroom, and bounds the parameter the driver accepts.
 */
export const MAX_BRANCH_LOCK_KEY_LENGTH = 512;

/** Default lease: 15 minutes, longer than a normal agent turn budget. */
export const DEFAULT_BRANCH_LOCK_TTL_MS = 15 * 60_000;
/** Shortest accepted lease: long enough for one bounded validation step. */
export const MIN_BRANCH_LOCK_TTL_MS = 5_000;
/** Longest accepted lease: an unreleased lock cannot outlive one hour. */
export const MAX_BRANCH_LOCK_TTL_MS = 60 * 60_000;

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BranchLockInput = {
	organizationId: OrganizationId;
	repositoryId: RepositoryId;
	branch: string;
	/**
	 * Lease duration. Defaults to 15 min; must be an integer in
	 * [5 s, 1 h]. A job longer than its lease can be taken over.
	 */
	ttlMs?: number;
};

export type BranchLockKeyResult =
	| { ok: true; key: string }
	| { ok: false; code: "INVALID_KEY" };

/**
 * Pure key normalization shared by the Postgres driver, the in-memory fake
 * and their tests. Ids must be UUIDs (lower-cased so the same logical id can
 * never address two locks); the branch is case-sensitive, non-empty and at
 * most 255 characters. Colons appear in no UUID and no git ref, so the
 * `org:repo:branch` encoding is unambiguous.
 */
export function evaluateBranchLockKey(
	input: BranchLockInput,
): BranchLockKeyResult {
	if (
		typeof input.organizationId !== "string" ||
		!UUID_PATTERN.test(input.organizationId) ||
		typeof input.repositoryId !== "string" ||
		!UUID_PATTERN.test(input.repositoryId)
	) {
		return { ok: false, code: "INVALID_KEY" };
	}
	if (
		typeof input.branch !== "string" ||
		input.branch.trim().length === 0 ||
		input.branch.length > MAX_BRANCH_LOCK_BRANCH_LENGTH ||
		input.branch.includes("\u0000")
	) {
		return { ok: false, code: "INVALID_KEY" };
	}
	const key = `${input.organizationId.toLowerCase()}:${input.repositoryId.toLowerCase()}:${input.branch}`;
	if (key.length > MAX_BRANCH_LOCK_KEY_LENGTH) {
		return { ok: false, code: "INVALID_KEY" };
	}
	return { ok: true, key };
}

/** Throwing form used by both implementations at the acquire boundary. */
export function requireBranchLockKey(input: BranchLockInput): string {
	const result = evaluateBranchLockKey(input);
	if (!result.ok) {
		throw new Error(
			"branch lock requires UUID organizationId and repositoryId plus a non-empty branch of at most 255 characters",
		);
	}
	return result.key;
}

/**
 * Resolves and bounds the lease duration. Throws on a non-integer or an
 * out-of-range value instead of silently clamping: a caller that asks for a
 * 1 ms lease has a bug, not a preference.
 */
export function resolveBranchLockTtlMs(ttlMs: number | undefined): number {
	const ttl = ttlMs ?? DEFAULT_BRANCH_LOCK_TTL_MS;
	if (!Number.isInteger(ttl) || ttl < MIN_BRANCH_LOCK_TTL_MS) {
		throw new Error(
			`branch lock ttlMs must be an integer of at least ${MIN_BRANCH_LOCK_TTL_MS}`,
		);
	}
	if (ttl > MAX_BRANCH_LOCK_TTL_MS) {
		throw new Error(
			`branch lock ttlMs must be at most ${MAX_BRANCH_LOCK_TTL_MS}`,
		);
	}
	return ttl;
}

export type BranchLockAcquireResult =
	| {
			ok: true;
			/**
			 * Opaque owner token minted by `acquire`. It is the only proof the
			 * holder can present to `renew` or `release`; it is not a secret
			 * (guessing it grants nothing that taking the lease would not).
			 */
			ownerId: string;
			/**
			 * Deletes the lease row only if this caller still owns it. Idempotent:
			 * later calls are no-ops, and an expired lease already taken over by
			 * another owner is left untouched.
			 */
			release(): Promise<void>;
	  }
	| { ok: false; code: "LOCKED" };

export type BranchLockRenewInput = {
	organizationId: OrganizationId;
	repositoryId: RepositoryId;
	branch: string;
	/** Owner token returned by the successful `acquire`. */
	ownerId: string;
	/**
	 * New lease duration from `now()`. Same bounds as acquire: an integer in
	 * [5 s, 1 h], default 15 min.
	 */
	ttlMs?: number;
};

/**
 * `LOST` is terminal for the holder: the row no longer carries this owner, so
 * the lease expired and was taken over (or was already released). The caller
 * must stop writing and let the job be retried; it must never acquire again
 * inside the same attempt.
 */
export type BranchLockRenewResult = { ok: true } | { ok: false; code: "LOST" };

export interface BranchLockRepository {
	/**
	 * Tries to take the lease for the triple. A miss is reported as `LOCKED`
	 * (bounded retry verdict), never as a block/wait. An expired lease is
	 * taken over atomically by the same statement.
	 */
	acquire(input: BranchLockInput): Promise<BranchLockAcquireResult>;
	/**
	 * Extends a held lease in place. One owner-guarded statement; no row means
	 * the lease is gone (`LOST`), never a silent success.
	 */
	renew(input: BranchLockRenewInput): Promise<BranchLockRenewResult>;
}

/** Throwing owner-token check shared by both implementations. */
function requireOwnerId(ownerId: string): void {
	if (typeof ownerId !== "string" || ownerId.length === 0) {
		throw new Error("branch lock ownerId must be a non-empty string");
	}
}

/**
 * One statement per operation; parameters are bound values only.
 *
 * `expires_at = EXCLUDED.expires_at` uses the DB clock (`now()`), so the
 * lease deadline and the takeover predicate (`expires_at < now()`) share one
 * clock even if the application host drifts.
 */
const ACQUIRE_SQL = `INSERT INTO branch_locks (
	organization_id, repository_id, branch, owner_id, expires_at
) VALUES (
	$1::uuid, $2::uuid, $3, $4,
	now() + $5::double precision * interval '1 millisecond'
)
ON CONFLICT (organization_id, repository_id, branch) DO UPDATE
SET owner_id = EXCLUDED.owner_id,
	expires_at = EXCLUDED.expires_at,
	acquired_at = now()
WHERE branch_locks.expires_at < now()
RETURNING owner_id`;

const RELEASE_SQL = `DELETE FROM branch_locks
WHERE organization_id = $1::uuid
	AND repository_id = $2::uuid
	AND branch = $3
	AND owner_id = $4`;

/**
 * One statement, owner-guarded. `RETURNING` is what makes a lost lease
 * observable: an UPDATE that matches nothing reports zero rows.
 */
const RENEW_SQL = `UPDATE branch_locks
SET expires_at = now() + $5::double precision * interval '1 millisecond'
WHERE organization_id = $1::uuid
	AND repository_id = $2::uuid
	AND branch = $3
	AND owner_id = $4
RETURNING owner_id`;

export class PostgresBranchLockRepository implements BranchLockRepository {
	constructor(private readonly sql: PgSql) {}

	async acquire(input: BranchLockInput): Promise<BranchLockAcquireResult> {
		// Validate through the shared helper, then bind its normalized parts.
		// No `sql.reserve()`: the lease must not depend on connection identity.
		requireBranchLockKey(input);
		const ttlMs = resolveBranchLockTtlMs(input.ttlMs);
		const organizationId = input.organizationId.toLowerCase();
		const repositoryId = input.repositoryId.toLowerCase();
		const ownerId = crypto.randomUUID();

		const rows = (await this.sql.unsafe(ACQUIRE_SQL, [
			organizationId,
			repositoryId,
			input.branch,
			ownerId,
			ttlMs,
		])) as unknown as Record<string, unknown>[];

		// A row is returned only when the insert won or the previous lease had
		// expired; matching the owner id proves it is ours. Zero rows = live
		// lease held by someone else.
		if (rows[0]?.owner_id !== ownerId) {
			return { ok: false, code: "LOCKED" };
		}

		let released = false;
		const release = async (): Promise<void> => {
			if (released) return;
			released = true;
			await this.sql.unsafe(RELEASE_SQL, [
				organizationId,
				repositoryId,
				input.branch,
				ownerId,
			]);
		};
		return { ok: true, ownerId, release };
	}

	async renew(input: BranchLockRenewInput): Promise<BranchLockRenewResult> {
		// Same normalization and bounds as acquire; an invalid triple or TTL is
		// a caller bug and throws before any statement runs.
		requireBranchLockKey(input);
		const ttlMs = resolveBranchLockTtlMs(input.ttlMs);
		requireOwnerId(input.ownerId);

		const rows = (await this.sql.unsafe(RENEW_SQL, [
			input.organizationId.toLowerCase(),
			input.repositoryId.toLowerCase(),
			input.branch,
			input.ownerId,
			ttlMs,
		])) as unknown as Record<string, unknown>[];

		// The WHERE clause already pins the owner; match the returned row as a
		// second proof (and to stay identical to acquire's row handling).
		return rows[0]?.owner_id === input.ownerId
			? { ok: true }
			: { ok: false, code: "LOST" };
	}
}
