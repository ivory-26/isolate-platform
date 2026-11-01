import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import type { PgSql } from "../client";
import { InMemoryRateLimitRepository } from "../testing/rate-limit-fake";
import {
	normalizeConsumeRateLimitInput,
	PostgresRateLimitRepository,
	RATE_LIMIT_MAX_KEY_CHARS,
	retryAfterSecondsFor,
	windowStartFor,
} from "./rate-limit";

const NOW = new Date("2026-11-01T00:00:00.000Z");

function expectValidation(error: unknown): void {
	expect(error).toBeInstanceOf(PlatformError);
	expect((error as PlatformError).code).toBe("VALIDATION_FAILED");
}

async function expectValidationRejection(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		expectValidation(error);
		return;
	}
	throw new Error("expected a VALIDATION_FAILED rejection");
}

describe("rate limit window math", () => {
	test("floors the window start and computes whole retry seconds", () => {
		const now = new Date("2026-11-01T00:00:30.500Z");
		const start = windowStartFor(now, 60);
		expect(start.toISOString()).toBe("2026-11-01T00:00:00.000Z");
		expect(retryAfterSecondsFor(now, start, 60)).toBe(30);
		expect(
			retryAfterSecondsFor(new Date("2026-11-01T00:00:59.001Z"), start, 60),
		).toBe(1);
		expect(
			retryAfterSecondsFor(new Date("2026-11-01T00:01:00.000Z"), start, 60),
		).toBe(0);
	});

	test("a different window length produces a different bucket", () => {
		expect(windowStartFor(NOW, 60).toISOString()).toBe(
			"2026-11-01T00:00:00.000Z",
		);
		expect(windowStartFor(NOW, 300).toISOString()).toBe(
			"2026-11-01T00:00:00.000Z",
		);
		expect(windowStartFor(NOW, 86_400).toISOString()).toBe(
			"2026-11-01T00:00:00.000Z",
		);
		expect(
			windowStartFor(
				new Date("2026-11-01T12:00:00.000Z"),
				86_400,
			).toISOString(),
		).toBe("2026-11-01T00:00:00.000Z");
	});
});

describe("in-memory rate limit repository", () => {
	test("allows exactly the limit and refuses the (limit + 1)th call", async () => {
		const repo = new InMemoryRateLimitRepository();
		const input = {
			key: "ip:203.0.113.7:device",
			limit: 2,
			windowSeconds: 60,
			now: new Date("2026-11-01T00:00:30.000Z"),
		};
		const first = await repo.consume(input);
		expect(first).toEqual({
			allowed: true,
			count: 1,
			remaining: 1,
			retryAfterSeconds: 0,
		});
		const second = await repo.consume(input);
		expect(second).toEqual({
			allowed: true,
			count: 2,
			remaining: 0,
			retryAfterSeconds: 0,
		});
		const denied = await repo.consume(input);
		expect(denied).toEqual({
			allowed: false,
			count: 2,
			remaining: 0,
			retryAfterSeconds: 30,
		});
		expect(repo.countFor(input.key, new Date("2026-11-01T00:00:00.000Z"))).toBe(
			2,
		);
	});

	test("a new window starts with a fresh counter", async () => {
		const repo = new InMemoryRateLimitRepository();
		const key = "user:33333333-3333-4333-8333-333333333333:device:register";
		for (let call = 0; call < 10; call += 1) {
			const result = await repo.consume({
				key,
				limit: 10,
				windowSeconds: 60,
				now: new Date("2026-11-01T00:00:10.000Z"),
			});
			expect(result.allowed).toBe(true);
		}
		const refused = await repo.consume({
			key,
			limit: 10,
			windowSeconds: 60,
			now: new Date("2026-11-01T00:00:59.000Z"),
		});
		expect(refused.allowed).toBe(false);
		const nextWindow = await repo.consume({
			key,
			limit: 10,
			windowSeconds: 60,
			now: new Date("2026-11-01T00:01:00.000Z"),
		});
		expect(nextWindow).toMatchObject({ allowed: true, count: 1 });
		expect(repo.rowCount).toBe(2);
	});

	test("two concurrent consumes at limit - 1 allow exactly one", async () => {
		const repo = new InMemoryRateLimitRepository();
		const input = {
			key: "org:11111111-1111-4111-8111-111111111111:connector:sentry:calls",
			limit: 2,
			windowSeconds: 60,
			now: NOW,
		};
		const seed = await repo.consume(input);
		expect(seed).toMatchObject({ allowed: true, count: 1 });
		const results = await Promise.all([
			repo.consume(input),
			repo.consume(input),
		]);
		expect(results.filter((result) => result.allowed)).toHaveLength(1);
		expect(results.filter((result) => !result.allowed)).toHaveLength(1);
	});

	test("separate keys and windows never share a counter", async () => {
		const repo = new InMemoryRateLimitRepository();
		await repo.consume({
			key: "webhook:sentry:global",
			limit: 1,
			windowSeconds: 60,
			now: NOW,
		});
		expect(
			await repo.consume({
				key: "webhook:github:global",
				limit: 1,
				windowSeconds: 60,
				now: NOW,
			}),
		).toMatchObject({ allowed: true });
		// Same key, different window length: at 00:00 both windows start at
		// 00:00, so the 300 s window is the same row. At 00:06 the 60 s window
		// starts at 00:06 while the 300 s one still starts at 00:05.
		const sameStart = await repo.consume({
			key: "webhook:sentry:global",
			limit: 1,
			windowSeconds: 300,
			now: NOW,
		});
		expect(sameStart.allowed).toBe(false);
		expect(
			await repo.consume({
				key: "webhook:sentry:global",
				limit: 1,
				windowSeconds: 60,
				now: new Date("2026-11-01T00:06:00.000Z"),
			}),
		).toMatchObject({ allowed: true });
	});

	test("deleteExpired removes only expired windows, bounded by maxRows", async () => {
		const repo = new InMemoryRateLimitRepository();
		for (let index = 0; index < 3; index += 1) {
			await repo.consume({
				key: `ip:10.0.0.${index}:device`,
				limit: 1,
				windowSeconds: 60,
				now: new Date("2026-11-01T00:00:00.000Z"),
			});
		}
		await repo.consume({
			key: "ip:10.0.1.0:device",
			limit: 1,
			windowSeconds: 60,
			now: new Date("2026-11-01T00:05:00.000Z"),
		});
		expect(repo.rowCount).toBe(4);
		const deleted = await repo.deleteExpired(
			new Date("2026-11-01T00:02:00.000Z"),
			2,
		);
		expect(deleted).toBe(2);
		expect(repo.rowCount).toBe(2);
		expect(await repo.deleteExpired(new Date("2026-11-01T00:10:00.000Z"))).toBe(
			2,
		);
		expect(repo.rowCount).toBe(0);
	});

	test("rejects malformed keys, limits, windows and clocks with fixed text", async () => {
		const repo = new InMemoryRateLimitRepository();
		for (const key of [
			"",
			" padded",
			"padded ",
			"x".repeat(RATE_LIMIT_MAX_KEY_CHARS + 1),
			"bad\u0000key",
		]) {
			await expectValidationRejection(
				repo.consume({ key, limit: 1, windowSeconds: 60, now: NOW }),
			);
		}
		for (const limit of [0, -1, 1.5, Number.NaN, 1_000_001]) {
			await expectValidationRejection(
				repo.consume({ key: "k", limit, windowSeconds: 60, now: NOW }),
			);
		}
		for (const windowSeconds of [0, -1, 1.5, 86_401]) {
			await expectValidationRejection(
				repo.consume({ key: "k", limit: 1, windowSeconds, now: NOW }),
			);
		}
		await expectValidationRejection(
			repo.consume({
				key: "k",
				limit: 1,
				windowSeconds: 60,
				now: new Date(Number.NaN),
			}),
		);
		await expectValidationRejection(repo.deleteExpired(NOW, 0));
		await expectValidationRejection(repo.deleteExpired(new Date(Number.NaN)));
	});

	test("normalization is pure and rejects before any SQL runs", async () => {
		const normalized = normalizeConsumeRateLimitInput({
			key: "ip:203.0.113.7:device",
			limit: 5,
			windowSeconds: 60,
			now: new Date("2026-11-01T00:00:42.000Z"),
		});
		expect(normalized.windowStart.toISOString()).toBe(
			"2026-11-01T00:00:00.000Z",
		);
		expect(normalized.expiresAt.toISOString()).toBe("2026-11-01T00:01:00.000Z");
		let queried = false;
		const sql = {
			unsafe: async () => {
				queried = true;
				return [];
			},
		} as unknown as PgSql;
		const postgres = new PostgresRateLimitRepository(sql);
		await expectValidationRejection(
			postgres.consume({ key: "", limit: 1, windowSeconds: 60, now: NOW }),
		);
		expect(queried).toBe(false);
	});
});
