import { describe, expect, test } from "bun:test";
import {
	asOrganizationId,
	asRepositoryId,
	type OrganizationId,
	type RepositoryId,
} from "@isolate/shared";
import type { PgSql } from "../client";
import { InMemoryBranchLockRepository } from "../testing/fakes";
import {
	type BranchLockInput,
	DEFAULT_BRANCH_LOCK_TTL_MS,
	evaluateBranchLockKey,
	MAX_BRANCH_LOCK_BRANCH_LENGTH,
	MAX_BRANCH_LOCK_KEY_LENGTH,
	MAX_BRANCH_LOCK_TTL_MS,
	MIN_BRANCH_LOCK_TTL_MS,
	PostgresBranchLockRepository,
	requireBranchLockKey,
	resolveBranchLockTtlMs,
} from "./branch-lock-repository";

const ORG = "10000000-0000-4000-8000-000000000001";
const REPO = "20000000-0000-4000-8000-000000000001";

function input(overrides: Partial<BranchLockInput> = {}): BranchLockInput {
	return {
		organizationId: asOrganizationId(ORG),
		repositoryId: asRepositoryId(REPO),
		branch: "task/demo",
		...overrides,
	};
}

describe("evaluateBranchLockKey (shared normalization)", () => {
	test("builds org:repo:branch and lower-cases UUIDs", () => {
		expect(evaluateBranchLockKey(input())).toEqual({
			ok: true,
			key: `${ORG}:${REPO}:task/demo`,
		});
		// The same logical triple in upper case must address the SAME lock.
		expect(
			evaluateBranchLockKey(
				input({ organizationId: asOrganizationId(ORG.toUpperCase()) }),
			),
		).toEqual({
			ok: true,
			key: `${ORG}:${REPO}:task/demo`,
		});
	});

	test("branch is case-sensitive and kept verbatim", () => {
		const lower = evaluateBranchLockKey(input({ branch: "task/demo" }));
		const upper = evaluateBranchLockKey(input({ branch: "TASK/demo" }));
		expect(lower.ok && upper.ok).toBe(true);
		if (lower.ok && upper.ok) {
			expect(lower.key).not.toBe(upper.key);
		}
	});

	test("rejects non-UUID ids, empty/oversized branches and NUL", () => {
		for (const bad of [
			input({ organizationId: asOrganizationId("org_1") }),
			input({ repositoryId: asRepositoryId("repo_1") }),
			input({ branch: "" }),
			input({ branch: "   " }),
			input({ branch: "b".repeat(MAX_BRANCH_LOCK_BRANCH_LENGTH + 1) }),
			input({ branch: "task/\u0000demo" }),
		]) {
			expect(evaluateBranchLockKey(bad)).toEqual({
				ok: false,
				code: "INVALID_KEY",
			});
		}
	});

	test("accepts the 255-char branch ceiling and keeps the key bounded", () => {
		const key = requireBranchLockKey(
			input({ branch: "b".repeat(MAX_BRANCH_LOCK_BRANCH_LENGTH) }),
		);
		expect(key.length).toBeLessThanOrEqual(MAX_BRANCH_LOCK_KEY_LENGTH);
		expect(key.length).toBe(
			ORG.length + REPO.length + MAX_BRANCH_LOCK_BRANCH_LENGTH + 2,
		);
	});

	test("requireBranchLockKey throws the same error as the fake", () => {
		expect(() => requireBranchLockKey(input({ branch: "" }))).toThrow(
			/branch lock requires UUID organizationId and repositoryId/,
		);
	});
});

describe("resolveBranchLockTtlMs (lease bounds)", () => {
	test("defaults to 15 minutes and accepts the inclusive bounds", () => {
		expect(resolveBranchLockTtlMs(undefined)).toBe(DEFAULT_BRANCH_LOCK_TTL_MS);
		expect(DEFAULT_BRANCH_LOCK_TTL_MS).toBe(15 * 60_000);
		expect(resolveBranchLockTtlMs(MIN_BRANCH_LOCK_TTL_MS)).toBe(
			MIN_BRANCH_LOCK_TTL_MS,
		);
		expect(resolveBranchLockTtlMs(MAX_BRANCH_LOCK_TTL_MS)).toBe(
			MAX_BRANCH_LOCK_TTL_MS,
		);
	});

	test("rejects sub-minimum, over-maximum and non-integer leases", () => {
		for (const bad of [
			MIN_BRANCH_LOCK_TTL_MS - 1,
			MAX_BRANCH_LOCK_TTL_MS + 1,
			0,
			-1,
			1_000.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(() => resolveBranchLockTtlMs(bad)).toThrow(/ttlMs/);
		}
	});
});

describe("InMemoryBranchLockRepository (row-lease contract)", () => {
	test("acquire is exclusive per triple and releases idempotently", async () => {
		const locks = new InMemoryBranchLockRepository();
		const first = await locks.acquire(input());
		expect(first.ok).toBe(true);
		expect(locks.heldCount).toBe(1);

		const same = await locks.acquire(input());
		expect(same).toEqual({ ok: false, code: "LOCKED" });
		// A different branch is unrelated and stays free.
		const otherBranch = await locks.acquire(input({ branch: "task/other" }));
		expect(otherBranch.ok).toBe(true);
		expect(locks.heldCount).toBe(2);

		if (!first.ok) return;
		await first.release();
		expect(locks.heldCount).toBe(1);
		// A second release is a no-op, not an error and not a double free.
		await first.release();
		expect(locks.heldCount).toBe(1);

		const reacquired = await locks.acquire(input());
		expect(reacquired.ok).toBe(true);
		expect(locks.heldCount).toBe(2);
		if (reacquired.ok) await reacquired.release();
		if (otherBranch.ok) await otherBranch.release();
		expect(locks.heldCount).toBe(0);
	});

	test("a different repository or organization on the same branch is free", async () => {
		const locks = new InMemoryBranchLockRepository();
		const held = await locks.acquire(input());
		expect(held.ok).toBe(true);

		const otherRepo = await locks.acquire(
			input({ repositoryId: asRepositoryId(crypto.randomUUID()) }),
		);
		const otherOrg = await locks.acquire(
			input({ organizationId: asOrganizationId(crypto.randomUUID()) }),
		);
		expect(otherRepo.ok).toBe(true);
		expect(otherOrg.ok).toBe(true);

		if (held.ok) await held.release();
		if (otherRepo.ok) await otherRepo.release();
		if (otherOrg.ok) await otherOrg.release();
	});

	test("a live lease blocks takeover until it expires", async () => {
		let now = new Date("2026-01-01T00:00:00.000Z");
		const locks = new InMemoryBranchLockRepository(() => now);
		const first = await locks.acquire(input({ ttlMs: MIN_BRANCH_LOCK_TTL_MS }));
		expect(first.ok).toBe(true);

		now = new Date(now.getTime() + MIN_BRANCH_LOCK_TTL_MS - 1);
		expect(
			await locks.acquire(input({ ttlMs: MIN_BRANCH_LOCK_TTL_MS })),
		).toEqual({ ok: false, code: "LOCKED" });

		now = new Date(now.getTime() + 1);
		const second = await locks.acquire(
			input({ ttlMs: MIN_BRANCH_LOCK_TTL_MS }),
		);
		expect(second.ok).toBe(true);
		expect(locks.heldCount).toBe(1);

		if (first.ok) await first.release();
		if (second.ok) await second.release();
	});

	test("expiry takeover: the previous owner's release leaves the new lease intact", async () => {
		let now = new Date("2026-01-01T00:00:00.000Z");
		const locks = new InMemoryBranchLockRepository(() => now);
		const first = await locks.acquire(input({ ttlMs: MIN_BRANCH_LOCK_TTL_MS }));
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		// Expired at exactly `expires_at <= now`: takeover is allowed.
		now = new Date(now.getTime() + MIN_BRANCH_LOCK_TTL_MS);
		const second = await locks.acquire(
			input({ ttlMs: MIN_BRANCH_LOCK_TTL_MS }),
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		// Wrong-owner release is a no-op: the second owner's lease survives.
		await first.release();
		expect(locks.heldCount).toBe(1);
		expect(await locks.acquire(input())).toEqual({
			ok: false,
			code: "LOCKED",
		});

		await second.release();
		expect(locks.heldCount).toBe(0);
	});

	test("validates input identically to the driver boundary", async () => {
		const locks = new InMemoryBranchLockRepository();
		await expect(
			locks.acquire({
				organizationId: ORG as OrganizationId,
				repositoryId: REPO as RepositoryId,
				branch: "",
			}),
		).rejects.toThrow(/branch lock requires UUID/);
		await expect(
			locks.acquire({
				organizationId: "org_1" as OrganizationId,
				repositoryId: REPO as RepositoryId,
				branch: "task/x",
			}),
		).rejects.toThrow(/branch lock requires UUID/);
		await expect(
			locks.acquire(
				input({ branch: "b".repeat(MAX_BRANCH_LOCK_BRANCH_LENGTH + 1) }),
			),
		).rejects.toThrow(/branch lock requires UUID/);
		await expect(locks.acquire(input({ ttlMs: 1 }))).rejects.toThrow(/ttlMs/);
		expect(locks.heldCount).toBe(0);
	});
});

type StubCall = { query: string; params: unknown[] };

/**
 * Minimal PgSql double: records statements and answers them. `reserve` throws
 * so any regression back to session state fails loudly.
 */
function stubSql(respond: (call: StubCall) => unknown): {
	sql: PgSql;
	calls: StubCall[];
} {
	const calls: StubCall[] = [];
	const sql = {
		unsafe: async (query: string, params: unknown[] = []) => {
			const call = { query, params };
			calls.push(call);
			return respond(call);
		},
		reserve: () => {
			throw new Error(
				"reserve() must not be used: the row lease holds no session",
			);
		},
	} as unknown as PgSql;
	return { sql, calls };
}

describe("PostgresBranchLockRepository (statement shape)", () => {
	test("acquire is ONE statement with no reserved connection", async () => {
		const { sql, calls } = stubSql((call) => [{ owner_id: call.params[3] }]);
		const locks = new PostgresBranchLockRepository(sql);
		const result = await locks.acquire(
			input({ organizationId: asOrganizationId(ORG.toUpperCase()) }),
		);
		expect(result.ok).toBe(true);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.query).toContain("INSERT INTO branch_locks");
		expect(call.query).toContain(
			"ON CONFLICT (organization_id, repository_id, branch) DO UPDATE",
		);
		expect(call.query).toContain("WHERE branch_locks.expires_at < now()");
		expect(call.query).toContain("RETURNING owner_id");
		// Normalized UUIDs, verbatim branch, fresh owner, default TTL.
		expect(call.params.slice(0, 3)).toEqual([ORG, REPO, "task/demo"]);
		expect(typeof call.params[3]).toBe("string");
		expect(call.params[4]).toBe(DEFAULT_BRANCH_LOCK_TTL_MS);

		if (result.ok) await result.release();
	});

	test("no RETURNING row is LOCKED; a foreign owner row is LOCKED", async () => {
		const empty = stubSql(() => []);
		expect(
			await new PostgresBranchLockRepository(empty.sql).acquire(input()),
		).toEqual({ ok: false, code: "LOCKED" });
		expect(empty.calls).toHaveLength(1);

		const foreign = stubSql(() => [{ owner_id: "someone-else" }]);
		expect(
			await new PostgresBranchLockRepository(foreign.sql).acquire(input()),
		).toEqual({ ok: false, code: "LOCKED" });
	});

	test("release is ONE owner-guarded DELETE and is idempotent", async () => {
		const { sql, calls } = stubSql((call) => [{ owner_id: call.params[3] }]);
		const locks = new PostgresBranchLockRepository(sql);
		const acquired = await locks.acquire(input({ ttlMs: 60_000 }));
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;

		await acquired.release();
		await acquired.release();

		expect(calls).toHaveLength(2); // acquire + exactly one delete
		const release = calls[1];
		expect(release.query).toContain("DELETE FROM branch_locks");
		expect(release.query).toContain("AND owner_id = $4");
		expect(release.params).toEqual([
			ORG,
			REPO,
			"task/demo",
			calls[0].params[3],
		]);
	});

	test("invalid key or ttl throws before any statement runs", async () => {
		const { sql, calls } = stubSql(() => [{ owner_id: "x" }]);
		const locks = new PostgresBranchLockRepository(sql);
		await expect(locks.acquire(input({ branch: "" }))).rejects.toThrow(
			/branch lock requires UUID/,
		);
		await expect(locks.acquire(input({ ttlMs: 1 }))).rejects.toThrow(/ttlMs/);
		expect(calls).toHaveLength(0);
	});
});
