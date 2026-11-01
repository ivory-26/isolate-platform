import { describe, expect, test } from "bun:test";
import { readRepositories } from "../../server/catalog-read.server";
import type { RepositoriesQuery } from "./contracts";

const ORG = "11111111-1111-4111-8111-111111111111";

function row(index: number) {
	return {
		id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		organization_id: ORG,
		provider: "github",
		external_full_name: `acme/repo-${String(index).padStart(3, "0")}`,
		default_branch: "main",
		validation_command: index % 2 === 0 ? "bun run validate" : null,
		validation_timeout_ms: "120000",
		created_at: new Date("2026-11-01T10:00:00.000Z"),
	};
}

function fakeSql(rows: Record<string, unknown>[]) {
	const calls: { query: string; parameters: readonly unknown[] }[] = [];
	return {
		calls,
		sql: {
			async unsafe(query: string, parameters?: readonly unknown[]) {
				calls.push({ query, parameters: parameters ?? [] });
				return rows;
			},
		},
	};
}

const query: RepositoriesQuery = { q: "acme", provider: "github" };

describe("readRepositories", () => {
	test("binds the organization, query and provider and maps a row", async () => {
		const { sql, calls } = fakeSql([row(1)]);
		const result = await readRepositories(sql, ORG, query);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.parameters).toEqual([ORG, "acme", "github"]);
		expect(result.truncated).toBe(false);
		expect(result.repositories[0]).toEqual({
			id: row(1).id,
			provider: "github",
			externalFullName: "acme/repo-001",
			defaultBranch: "main",
			validationCommand: null,
			validationTimeoutMs: 120_000,
			createdAt: "2026-11-01T10:00:00.000Z",
		});
	});

	test("caps the response at 200 rows and marks truncation", async () => {
		const { sql } = fakeSql(
			Array.from({ length: 201 }, (_, index) => row(index)),
		);
		const result = await readRepositories(sql, ORG, {
			q: "",
			provider: undefined,
		});
		expect(result.repositories).toHaveLength(200);
		expect(result.truncated).toBe(true);
		expect(result.repositories[0]?.validationCommand).toBe("bun run validate");
	});

	test("fails closed on an unexpected driver row shape", async () => {
		const { sql } = fakeSql([]);
		const broken = {
			unsafe: async () => ({ rows: [] }),
		};
		await expect(readRepositories(sql, ORG, query)).resolves.toBeDefined();
		await expect(readRepositories(broken, ORG, query)).rejects.toThrow(
			"unexpected row shape",
		);
	});
});
