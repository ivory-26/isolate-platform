import { describe, expect, test } from "bun:test";
import { asOrganizationId, type OrganizationId } from "@isolate/shared";
import { InMemoryRepositoryRepository } from "../testing/execution-truth-fakes";
import {
	DEFAULT_VALIDATION_TIMEOUT_MS,
	normalizeValidationPolicy,
	validateCreateRepositoryInput,
} from "./repository-repository";

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

describe("validation policy (RepositoryRepository.setValidationPolicy)", () => {
	test("new repositories start with no command and the default timeout", async () => {
		const repos = new InMemoryRepositoryRepository(fixedClock());
		const created = await repos.create(input(orgA));
		if (!created.ok) throw new Error("seed failed");
		expect(created.repository.validation_command).toBeNull();
		expect(created.repository.validation_timeout_ms).toBe(
			DEFAULT_VALIDATION_TIMEOUT_MS,
		);
	});

	test("normalizeValidationPolicy trims, clears blank, and bounds the timeout", () => {
		expect(
			normalizeValidationPolicy({
				validationCommand: "  bun test  ",
				validationTimeoutMs: 120000,
			}),
		).toEqual({ validationCommand: "bun test", validationTimeoutMs: 120000 });
		for (const blank of ["", "   ", null]) {
			expect(
				normalizeValidationPolicy({
					validationCommand: blank,
					validationTimeoutMs: 1000,
				}).validationCommand,
			).toBeNull();
		}
		for (const timeout of [999, 900001, 1000.5, Number.NaN]) {
			expect(() =>
				normalizeValidationPolicy({
					validationCommand: "bun test",
					validationTimeoutMs: timeout,
				}),
			).toThrow(/validationTimeoutMs/);
		}
		expect(
			normalizeValidationPolicy({
				validationCommand: "bun test",
				validationTimeoutMs: 900000,
			}).validationTimeoutMs,
		).toBe(900000);
	});

	test("normalizeValidationPolicy rejects oversize and shell-bearing commands", () => {
		expect(() =>
			normalizeValidationPolicy({
				validationCommand: "x".repeat(513),
				validationTimeoutMs: 60000,
			}),
		).toThrow(/512/);
		// One probe per forbidden metacharacter class; none may reach the DB.
		for (const command of [
			"bun test; rm -rf /",
			"bun test | tee out",
			"bun test && echo ok",
			"bun test > out.log",
			"bun test < input",
			"bun test $(whoami)",
			"bun test `whoami`",
			"bun test\nrm -rf /",
		]) {
			expect(() =>
				normalizeValidationPolicy({
					validationCommand: command,
					validationTimeoutMs: 60000,
				}),
			).toThrow(/metacharacters/);
		}
		// A colon-bearing script name is legitimate and stays verbatim.
		expect(
			normalizeValidationPolicy({
				validationCommand: "bun run test:unit",
				validationTimeoutMs: 60000,
			}).validationCommand,
		).toBe("bun run test:unit");
	});

	test("setValidationPolicy updates the read shape and clears with null", async () => {
		const repos = new InMemoryRepositoryRepository(fixedClock());
		const created = await repos.create(input(orgA));
		if (!created.ok) throw new Error("seed failed");
		const updated = await repos.setValidationPolicy({
			organizationId: orgA,
			repositoryId: created.repository.id,
			validationCommand: "bun test",
			validationTimeoutMs: 60000,
		});
		expect(updated).toMatchObject({
			validation_command: "bun test",
			validation_timeout_ms: 60000,
		});
		expect(
			await repos.get({
				organizationId: orgA,
				repositoryId: created.repository.id,
			}),
		).toMatchObject({ validation_command: "bun test" });
		expect(
			(
				await repos.setValidationPolicy({
					organizationId: orgA,
					repositoryId: created.repository.id,
					validationCommand: null,
					validationTimeoutMs: DEFAULT_VALIDATION_TIMEOUT_MS,
				})
			)?.validation_command,
		).toBeNull();
	});

	test("setValidationPolicy is tenant-scoped and never writes a foreign row", async () => {
		const repos = new InMemoryRepositoryRepository(fixedClock());
		const created = await repos.create(input(orgA));
		if (!created.ok) throw new Error("seed failed");
		expect(
			await repos.setValidationPolicy({
				organizationId: orgB,
				repositoryId: created.repository.id,
				validationCommand: "bun test",
				validationTimeoutMs: 60000,
			}),
		).toBeNull();
		expect(
			(
				await repos.get({
					organizationId: orgA,
					repositoryId: created.repository.id,
				})
			)?.validation_command,
		).toBeNull();
	});
});
