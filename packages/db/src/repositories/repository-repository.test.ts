import { describe, expect, test } from "bun:test";
import { asOrganizationId, type OrganizationId } from "@isolate/shared";
import { InMemoryRepositoryRepository } from "../testing/execution-truth-fakes";
import { validateCreateRepositoryInput } from "./repository-repository";

const orgA = asOrganizationId("10000000-0000-4000-8000-000000000001");
const orgB = asOrganizationId("10000000-0000-4000-8000-000000000002");

function fixedClock(): () => Date {
	return () => new Date("2026-10-30T12:00:00.000Z");
}

function input(organizationId: OrganizationId, fullName = "acme/widgets") {
	return {
		organizationId,
		externalFullName: fullName,
		defaultBranch: "main",
	} as const;
}

describe("InMemoryRepositoryRepository (RepositoryRepository contract)", () => {
	test("create stores one repository under its organization and get finds it", async () => {
		const repos = new InMemoryRepositoryRepository(fixedClock());
		const result = await repos.create(input(orgA));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.repository).toMatchObject({
			organization_id: orgA,
			provider: "github",
			external_full_name: "acme/widgets",
			default_branch: "main",
			created_at: new Date("2026-10-30T12:00:00.000Z"),
		});
		expect(
			await repos.get({
				organizationId: orgA,
				repositoryId: result.repository.id,
			}),
		).toEqual(result.repository);
	});

	test("duplicate full name in the same organization is CONFLICT", async () => {
		const repos = new InMemoryRepositoryRepository(fixedClock());
		expect((await repos.create(input(orgA))).ok).toBe(true);
		expect(await repos.create(input(orgA))).toEqual({
			ok: false,
			code: "CONFLICT",
		});
		// Case is stored verbatim, so a differently-cased name is distinct.
		expect((await repos.create(input(orgA, "Acme/Widgets"))).ok).toBe(true);
	});

	test("the same full name may exist in another organization", async () => {
		const repos = new InMemoryRepositoryRepository(fixedClock());
		expect((await repos.create(input(orgA))).ok).toBe(true);
		expect((await repos.create(input(orgB))).ok).toBe(true);
		const listedB = await repos.list(orgB);
		expect(listedB).toHaveLength(1);
		expect(listedB[0].organization_id).toBe(orgB);
	});

	test("get is tenant-scoped: a foreign repository id is null", async () => {
		const repos = new InMemoryRepositoryRepository(fixedClock());
		const created = await repos.create(input(orgA));
		if (!created.ok) throw new Error("seed failed");
		expect(
			await repos.get({
				organizationId: orgB,
				repositoryId: created.repository.id,
			}),
		).toBeNull();
	});

	test("list filters by organization and orders by full name", async () => {
		const repos = new InMemoryRepositoryRepository(fixedClock());
		await repos.create(input(orgA, "zeta/repo"));
		await repos.create(input(orgA, "alpha/repo"));
		await repos.create(input(orgB, "only/foreign"));
		const listed = await repos.list(orgA);
		expect(listed.map((row) => row.external_full_name)).toEqual([
			"alpha/repo",
			"zeta/repo",
		]);
	});

	test("validation rejects malformed names, providers and blank ids", () => {
		expect(() =>
			validateCreateRepositoryInput(input(orgA, "not-a-full-name")),
		).toThrow(/owner\/repo/);
		expect(() =>
			validateCreateRepositoryInput(input(orgA, "acme/widgets extra")),
		).toThrow(/whitespace/);
		expect(() =>
			validateCreateRepositoryInput({
				...input(orgA),
				provider: "gitlab" as never,
			}),
		).toThrow(/github/);
		expect(() =>
			validateCreateRepositoryInput({
				...input(orgA),
				defaultBranch: "",
			}),
		).toThrow(/defaultBranch/);
	});
});
