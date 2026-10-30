import { describe, expect, test } from "bun:test";
import {
	asOrganizationId,
	asRepositoryId,
	type OrganizationId,
	type RepositoryId,
} from "@isolate/shared";
import { InMemoryBranchLockRepository } from "../testing/fakes";
import {
	type BranchLockInput,
	evaluateBranchLockKey,
	MAX_BRANCH_LOCK_BRANCH_LENGTH,
	MAX_BRANCH_LOCK_KEY_LENGTH,
	requireBranchLockKey,
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

describe("InMemoryBranchLockRepository (BranchLockRepository contract)", () => {
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
		expect(locks.heldCount).toBe(0);
	});
});
