import { describe, expect, test } from "bun:test";
import { asOrganizationId } from "@isolate/shared";
import type { PgSql } from "../client";
import { InMemoryConnectorCredentialRepository } from "../testing/connector-credentials-fake";
import { InMemoryConnectorUsageLedger } from "../testing/connector-usage-ledger-fake";
import {
	PostgresConnectorUsageLedgerRepository,
	requireUsagePeriod,
} from "./connector-usage-ledger";

const ORG = asOrganizationId("11111111-1111-4111-8111-111111111111");
const PERIOD = "2026-10-31";

async function ledgerFixture() {
	const credentials = new InMemoryConnectorCredentialRepository();
	const credential = await credentials.create({
		organizationId: ORG,
		connectorId: "sentry",
		displayName: "Team Sentry",
		authKind: "api_key",
		ciphertext: {
			encryptedPayload: new Uint8Array([1]),
			wrappedDek: new Uint8Array([2]),
			keyVersion: 1,
		},
		status: "active",
	});
	const ledger = new InMemoryConnectorUsageLedger(credentials);
	return { credentials, credential, ledger };
}

describe("in-memory connector usage ledger", () => {
	test("refuses the (limit + 1)th call in the period", async () => {
		const { credential, ledger } = await ledgerFixture();
		const options = { limitPerPeriod: 3, period: PERIOD };
		const results = [];
		for (let call = 0; call < 4; call += 1) {
			results.push(await ledger.consume(credential.id, options));
		}
		expect(results.map((result) => result.consumed)).toEqual([
			true,
			true,
			true,
			false,
		]);
		expect(results.map((result) => result.requestCount)).toEqual([1, 2, 3, 3]);
		const row = await ledger.get(credential.id, PERIOD);
		expect(row?.requestCount).toBe(3);
		expect(row?.organizationId).toBe(ORG);
		expect(row?.connectorId).toBe("sentry");
		expect(row?.period).toBe(PERIOD);
	});

	test("parallel consumes respect the limit", async () => {
		const { credential, ledger } = await ledgerFixture();
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				ledger.consume(credential.id, {
					limitPerPeriod: 3,
					period: PERIOD,
				}),
			),
		);
		expect(results.filter((result) => result.consumed)).toHaveLength(3);
		expect(
			results.map((result) => result.requestCount).sort((a, b) => a - b),
		).toEqual([1, 2, 3, 3, 3, 3, 3, 3, 3, 3]);
		const row = await ledger.get(credential.id, PERIOD);
		expect(row?.requestCount).toBe(3);
	});

	test("unknown credentials consume nothing and create no row", async () => {
		const ledger = new InMemoryConnectorUsageLedger();
		const result = await ledger.consume("missing", {
			limitPerPeriod: 5,
			period: PERIOD,
		});
		expect(result).toEqual({ consumed: false, requestCount: 0 });
		expect(ledger.rowCount).toBe(0);
	});

	test("periods are separate counters and are validated", async () => {
		const { credential, ledger } = await ledgerFixture();
		expect(
			await ledger.consume(credential.id, {
				limitPerPeriod: 1,
				period: PERIOD,
			}),
		).toEqual({ consumed: true, requestCount: 1 });
		expect(
			await ledger.consume(credential.id, {
				limitPerPeriod: 1,
				period: "2026-11-01",
			}),
		).toEqual({ consumed: true, requestCount: 1 });
		expect(ledger.rowCount).toBe(2);
		for (const invalid of ["2026-13-01", "2026-02-31", "31-10-2026", ""]) {
			expect(() => requireUsagePeriod(invalid)).toThrow();
		}
		await expect(
			ledger.consume(credential.id, { limitPerPeriod: 0, period: PERIOD }),
		).rejects.toThrow();
	});
});

describe("Postgres connector usage ledger", () => {
	test("consume is one INSERT ... ON CONFLICT statement with a limit guard", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				return [{ request_count: 2 }];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorUsageLedgerRepository(sql);
		const result = await repo.consume("credential-id", {
			limitPerPeriod: 12,
			period: PERIOD,
		});
		expect(result).toEqual({ consumed: true, requestCount: 2 });
		expect(calls).toHaveLength(1);
		expect(calls[0].query).toContain("ON CONFLICT (credential_id, period)");
		expect(calls[0].query).toContain("connector_usage_ledger.request_count <");
		expect(calls[0].query).toContain("RETURNING request_count");
		expect(calls[0].params).toEqual(["credential-id", PERIOD, 12]);
	});

	test("a missing RETURNING row reports the current count without incrementing", async () => {
		const queries: string[] = [];
		const sql = {
			unsafe: async (query: string) => {
				queries.push(query);
				return query.includes("INSERT")
					? []
					: [
							{
								id: "row-id",
								organization_id: ORG,
								credential_id: "credential-id",
								connector_id: "sentry",
								period: PERIOD,
								request_count: 12,
								error_count: 0,
								updated_at: new Date("2026-10-31T12:00:00.000Z"),
							},
						];
			},
		} as unknown as PgSql;
		const repo = new PostgresConnectorUsageLedgerRepository(sql);
		const result = await repo.consume("credential-id", {
			limitPerPeriod: 12,
			period: PERIOD,
		});
		expect(result).toEqual({ consumed: false, requestCount: 12 });
		expect(queries).toHaveLength(2);
		expect(queries[1]).toContain("period = $2::date");
	});
});
