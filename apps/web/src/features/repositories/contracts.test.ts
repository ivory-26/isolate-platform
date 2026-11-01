import { describe, expect, test } from "bun:test";
import { parseRepositoriesSearch, registerRepositorySchema } from "./contracts";
import {
	prepareRepositoryCreate,
	prepareRepositoryPolicy,
} from "./registration";

const base = {
	provider: "github",
	externalFullName: "acme/widgets",
	defaultBranch: "main",
} as const;

describe("registerRepositorySchema", () => {
	test("accepts a bounded GitHub registration and defaults the timeout", () => {
		const parsed = registerRepositorySchema.parse(base);
		expect(parsed.validationCommand).toBeUndefined();
		expect(parsed.validationTimeoutMs).toBe(300_000);
	});

	test("trims authored identifiers", () => {
		const parsed = registerRepositorySchema.parse({
			...base,
			externalFullName: "  acme/widgets  ",
			defaultBranch: "  release/main ",
		});
		expect(parsed.externalFullName).toBe("acme/widgets");
		expect(parsed.defaultBranch).toBe("release/main");
	});

	test("refuses an unknown provider", () => {
		expect(
			registerRepositorySchema.safeParse({ ...base, provider: "gitlab" })
				.success,
		).toBe(false);
	});

	test("requires the owner/repo shape without whitespace", () => {
		for (const externalFullName of [
			"widgets",
			"acme/",
			"/widgets",
			"acme/widgets/extra",
			"acme widgets/other",
			"acme/../other",
		]) {
			expect(
				registerRepositorySchema.safeParse({ ...base, externalFullName })
					.success,
			).toBe(false);
		}
	});

	test("refuses an invalid default branch", () => {
		for (const defaultBranch of ["", "-main", "feature branch", "a//b", "a/"]) {
			expect(
				registerRepositorySchema.safeParse({ ...base, defaultBranch }).success,
			).toBe(false);
		}
	});

	test("refuses shell metacharacters and control characters", () => {
		for (const validationCommand of [
			"bun run validate; rm -rf /",
			"bun run validate && echo ok",
			"bun run validate\nrm",
			"echo $HOME",
			"cat < file",
		]) {
			expect(
				registerRepositorySchema.safeParse({ ...base, validationCommand })
					.success,
			).toBe(false);
		}
		expect(
			registerRepositorySchema.safeParse({
				...base,
				validationCommand: "bun run validate",
			}).success,
		).toBe(true);
	});

	test("bounds the validation timeout", () => {
		for (const validationTimeoutMs of [999, 900_001, 1.5]) {
			expect(
				registerRepositorySchema.safeParse({ ...base, validationTimeoutMs })
					.success,
			).toBe(false);
		}
		expect(
			registerRepositorySchema.safeParse({
				...base,
				validationTimeoutMs: 1_000,
			}).success,
		).toBe(true);
		expect(
			registerRepositorySchema.safeParse({
				...base,
				validationTimeoutMs: 900_000,
			}).success,
		).toBe(true);
	});
});

describe("parseRepositoriesSearch", () => {
	test("defaults to an empty, unfiltered search", () => {
		expect(parseRepositoriesSearch({})).toEqual({ q: "", provider: undefined });
	});

	test("accepts the github provider and trims the query", () => {
		expect(
			parseRepositoriesSearch({ q: "  acme  ", provider: "github" }),
		).toEqual({ q: "acme", provider: "github" });
	});

	test("ignores an unknown provider and caps the query length", () => {
		const parsed = parseRepositoriesSearch({
			q: "x".repeat(140),
			provider: "gitlab",
		});
		expect(parsed.provider).toBeUndefined();
		expect(parsed.q).toHaveLength(100);
	});
});

describe("registration normalization", () => {
	const parsed = registerRepositorySchema.parse({
		...base,
		validationCommand: "  bun run validate  ",
		validationTimeoutMs: 120_000,
	});

	test("sends only the scalar columns to create", () => {
		expect(prepareRepositoryCreate(parsed)).toEqual({
			provider: "github",
			externalFullName: "acme/widgets",
			defaultBranch: "main",
		});
	});

	test("sends a normalized policy when one was authored", () => {
		expect(prepareRepositoryPolicy(parsed)).toEqual({
			validationCommand: "bun run validate",
			validationTimeoutMs: 120_000,
		});
	});

	test("skips the policy write at its defaults", () => {
		expect(prepareRepositoryPolicy(registerRepositorySchema.parse(base))).toBe(
			null,
		);
		expect(
			prepareRepositoryPolicy(
				registerRepositorySchema.parse({ ...base, validationCommand: "" }),
			),
		).toBe(null);
	});

	test("a custom timeout with no command still writes a policy", () => {
		expect(
			prepareRepositoryPolicy(
				registerRepositorySchema.parse({
					...base,
					validationTimeoutMs: 1_000,
				}),
			),
		).toEqual({ validationCommand: null, validationTimeoutMs: 1_000 });
	});
});
