import type { OrganizationId, RepositoryId } from "@isolate/shared";
import type { PgSql } from "../client";

/**
 * Advisory-lock repository for one (organization, repository, branch) triple.
 *
 * The worker takes this lock before provisioning a sandbox and releases it in
 * `finally`, so two jobs can never mutate the same branch concurrently. The
 * lock is a PostgreSQL SESSION-scoped advisory lock:
 *
 * - It is acquired on one PINNED pooled connection (`sql.reserve()`), not on
 *   whichever pooled connection happens to run the next statement.
 * - It MUST NOT outlive that connection's reservation. `release()` runs
 *   `pg_advisory_unlock` on the same connection and only then returns it to
 *   the pool; while the connection stays alive without an explicit unlock the
 *   session lock would leak into the next borrower.
 * - Session advisory locks require a DIRECT (non-PgBouncer-transaction-pooled)
 *   endpoint. On a transaction-pooled URL the unlock may be routed to a
 *   different backend connection than the one holding the lock. Configure the
 *   worker with a direct Neon URL when branch locking is enabled.
 * - If the connection dies, PostgreSQL releases the session lock server-side;
 *   the lock is never persisted in a table and never survives a restart.
 *
 * Keys are normalized by `evaluateBranchLockKey` and hashed inside Postgres
 * (`hashtext` -> bigint) so the lock name stays a bounded 64-bit advisory key.
 * Two unrelated triples may theoretically hash-collide; the consequence is a
 * spurious `LOCKED` (never two writers on one branch), which the worker
 * reports as a bounded retry verdict.
 */

/** Longest accepted branch name; mirrors the 0006 retry-branch clamp. */
export const MAX_BRANCH_LOCK_BRANCH_LENGTH = 255;

/**
 * Longest composite key handed to `hashtext()`: two 36-char UUIDs, two
 * separators and a 255-char branch = 329 characters. 512 is a hard cap with
 * headroom, and bounds the parameter the driver accepts.
 */
export const MAX_BRANCH_LOCK_KEY_LENGTH = 512;

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BranchLockInput = {
	organizationId: OrganizationId;
	repositoryId: RepositoryId;
	branch: string;
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

export type BranchLockAcquireResult =
	| {
			ok: true;
			/**
			 * Idempotent: the first call unlocks on the pinned connection and
			 * returns it to the pool; later calls are no-ops.
			 */
			release(): Promise<void>;
	  }
	| { ok: false; code: "LOCKED" };

export interface BranchLockRepository {
	/**
	 * Tries to take the session lock for the triple. A miss is reported as
	 * `LOCKED` (bounded retry verdict), never as a block/wait.
	 */
	acquire(input: BranchLockInput): Promise<BranchLockAcquireResult>;
}

/** Statements are static; the only value is the bound composite key. */
const TRY_LOCK_SQL =
	"SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked";
const UNLOCK_SQL =
	"SELECT pg_advisory_unlock(hashtext($1)::bigint) AS unlocked";

export class PostgresBranchLockRepository implements BranchLockRepository {
	constructor(private readonly sql: PgSql) {}

	async acquire(input: BranchLockInput): Promise<BranchLockAcquireResult> {
		const key = requireBranchLockKey(input);
		// Pin ONE connection from the pool: session locks are tied to the
		// backend session, so every lock/unlock statement must use this handle.
		const reserved = await this.sql.reserve();
		let locked = false;
		try {
			const rows = (await reserved.unsafe(TRY_LOCK_SQL, [
				key,
			])) as unknown as Record<string, unknown>[];
			locked = rows[0]?.locked === true;
		} catch (error) {
			// Never leak a reserved connection when the lock statement fails.
			reserved.release();
			throw error;
		}
		if (!locked) {
			reserved.release();
			return { ok: false, code: "LOCKED" };
		}

		let released = false;
		const release = async (): Promise<void> => {
			if (released) return;
			released = true;
			try {
				await reserved.unsafe(UNLOCK_SQL, [key]);
			} finally {
				// Always return the pinned connection; the server also drops the
				// session lock if the underlying session is closed.
				reserved.release();
			}
		};
		return { ok: true, release };
	}
}
