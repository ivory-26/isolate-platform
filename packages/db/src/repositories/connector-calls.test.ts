import { describe, expect, test } from "bun:test";
import { asOrganizationId, PlatformError } from "@isolate/shared";
import { InMemoryConnectorCallRepository } from "../testing/connector-calls-fake";
import {
	CONNECTOR_CALL_MAX_PARAMS_BYTES,
	CONNECTOR_CALL_MAX_RESULT_BYTES,
	CONNECTOR_CALL_MAX_TTL_MS,
	type EnqueueConnectorCallInput,
	mapConnectorCallRow,
	normalizeBoundedConnectorJsonObject,
} from "./connector-calls";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const DEVICE_A = "33333333-3333-4333-8333-333333333333";
const DEVICE_B = "44444444-4444-4444-8444-444444444444";
const CREDENTIAL_A = "55555555-5555-4555-8555-555555555555";
const TASK_ID = "66666666-6666-4666-8666-666666666666";

function enqueueInput(
	overrides: Partial<EnqueueConnectorCallInput> = {},
): EnqueueConnectorCallInput {
	return {
		organizationId: ORG_A,
		deviceId: DEVICE_A,
		credentialId: CREDENTIAL_A,
		taskId: TASK_ID,
		connectorId: "sentry",
		toolName: "sentry.issue_context",
		params: { issueId: "SENTRY-1" },
		ttlMs: 60_000,
		...overrides,
	};
}

function expectValidation(error: unknown): void {
	expect(error).toBeInstanceOf(PlatformError);
	expect((error as PlatformError).code).toBe("VALIDATION_FAILED");
}

async function expectValidationRejection(
	promise: Promise<unknown>,
): Promise<void> {
	try {
		await promise;
	} catch (error) {
		expectValidation(error);
		return;
	}
	throw new Error("expected a VALIDATION_FAILED rejection");
}

describe("in-memory connector call repository", () => {
	test("enqueue stores a queued call with typed params only", async () => {
		const repo = new InMemoryConnectorCallRepository();
		const call = await repo.enqueue(enqueueInput());
		expect(call.status).toBe("queued");
		expect(call.attempts).toBe(0);
		expect(call.params).toEqual({ issueId: "SENTRY-1" });
		expect(call.credentialId).toBe(CREDENTIAL_A);
		expect(call.taskId).toBe(TASK_ID);
		expect(call.expiresAt.getTime()).toBeGreaterThan(Date.now());
		const serialized = JSON.stringify(call);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("apiKey");
	});

	test("enqueue rejects malformed identifiers, tools and ttl", async () => {
		const repo = new InMemoryConnectorCallRepository();
		const cases: Partial<EnqueueConnectorCallInput>[] = [
			{ organizationId: "" as typeof ORG_A },
			{ deviceId: "" },
			{ credentialId: "" },
			{ connectorId: "Sentry" },
			{ toolName: "Sentry.Issue" },
			{ toolName: "x".repeat(65) },
			{ ttlMs: 0 },
			{ ttlMs: CONNECTOR_CALL_MAX_TTL_MS + 1 },
		];
		for (const overrides of cases) {
			await expectValidationRejection(repo.enqueue(enqueueInput(overrides)));
		}
		expect(repo.rowCount).toBe(0);
	});

	test("enqueue rejects non-object, oversized and credential-shaped params", async () => {
		const repo = new InMemoryConnectorCallRepository();
		for (const params of [["not", "an", "object"], null, "text"] as unknown[]) {
			await expectValidationRejection(
				repo.enqueue(
					enqueueInput({ params: params as Record<string, unknown> }),
				),
			);
		}
		const oversized = { blob: "a".repeat(CONNECTOR_CALL_MAX_PARAMS_BYTES) };
		await expect(
			repo.enqueue(enqueueInput({ params: oversized })),
		).rejects.toBeInstanceOf(PlatformError);
		const token = `ghp_${"a".repeat(30)}`;
		await expectValidationRejection(
			repo.enqueue(enqueueInput({ params: { note: `token ${token}` } })),
		);
		expect(repo.rowCount).toBe(0);
	});

	test("claimNext is oldest-first, device-scoped and increments attempts", async () => {
		const clock = new InMemoryConnectorCallRepository();
		const first = await clock.enqueue(
			enqueueInput({ params: { order: 1 }, connectorId: "sentry" }),
		);
		const second = await clock.enqueue(
			enqueueInput({
				params: { order: 2 },
				connectorId: "grafana",
				deviceId: DEVICE_B,
			}),
		);
		const claimed = await clock.claimNext(DEVICE_A);
		expect(claimed?.id).toBe(first.id);
		expect(claimed?.status).toBe("claimed");
		expect(claimed?.attempts).toBe(1);
		expect(claimed?.claimedAt).not.toBeNull();
		expect(await clock.claimNext(DEVICE_A)).toBeNull();
		expect((await clock.claimNext(DEVICE_B))?.id).toBe(second.id);
	});

	test("two concurrent claims never receive the same call", async () => {
		const repo = new InMemoryConnectorCallRepository();
		await repo.enqueue(enqueueInput());
		const [left, right] = await Promise.all([
			repo.claimNext(DEVICE_A),
			repo.claimNext(DEVICE_A),
		]);
		const claimed = [left, right].filter((call) => call !== null);
		expect(claimed).toHaveLength(1);
		expect(repo.peek(claimed[0]?.id ?? "")?.attempts).toBe(1);
	});

	test("two concurrent claims drain two queued calls without overlap", async () => {
		const repo = new InMemoryConnectorCallRepository();
		await repo.enqueue(enqueueInput({ params: { order: 1 } }));
		await repo.enqueue(enqueueInput({ params: { order: 2 } }));
		const [left, right] = await Promise.all([
			repo.claimNext(DEVICE_A),
			repo.claimNext(DEVICE_A),
		]);
		expect(left).not.toBeNull();
		expect(right).not.toBeNull();
		expect(left?.id).not.toBe(right?.id);
	});

	test("claimNext ignores calls past their deadline", async () => {
		let now = new Date("2026-11-01T00:00:00.000Z");
		const repo = new InMemoryConnectorCallRepository({ now: () => now });
		await repo.enqueue(enqueueInput({ ttlMs: 1_000 }));
		now = new Date("2026-11-01T00:00:02.000Z");
		expect(await repo.claimNext(DEVICE_A)).toBeNull();
	});

	test("complete stores the result and replays idempotently", async () => {
		const repo = new InMemoryConnectorCallRepository();
		const call = await repo.enqueue(enqueueInput());
		await repo.claimNext(DEVICE_A);
		const first = await repo.complete({
			callId: call.id,
			deviceId: DEVICE_A,
			result: { issue: { id: "SENTRY-1" } },
		});
		expect(first).toEqual({ ok: true, replayed: false });
		const replay = await repo.complete({
			callId: call.id,
			deviceId: DEVICE_A,
			result: { issue: { id: "OVERWRITE" } },
		});
		expect(replay).toEqual({ ok: true, replayed: true });
		const stored = repo.peek(call.id);
		expect(stored?.status).toBe("completed");
		expect(stored?.result).toEqual({ issue: { id: "SENTRY-1" } });
		expect(stored?.completedAt).not.toBeNull();
	});

	test("complete and fail reject a foreign device without revealing the row", async () => {
		const repo = new InMemoryConnectorCallRepository();
		const call = await repo.enqueue(enqueueInput());
		await repo.claimNext(DEVICE_A);
		expect(
			await repo.complete({
				callId: call.id,
				deviceId: DEVICE_B,
				result: { ok: true },
			}),
		).toEqual({ ok: false, code: "NOT_FOUND" });
		expect(
			await repo.fail({
				callId: call.id,
				deviceId: DEVICE_B,
				errorCode: "RATE_LIMITED",
			}),
		).toEqual({ ok: false, code: "NOT_FOUND" });
		expect(repo.peek(call.id)?.status).toBe("claimed");
		expect(await repo.claimNext(DEVICE_A)).toBeNull();
	});

	test("a queued call cannot be completed before it is claimed", async () => {
		const repo = new InMemoryConnectorCallRepository();
		const call = await repo.enqueue(enqueueInput());
		expect(
			await repo.complete({
				callId: call.id,
				deviceId: DEVICE_A,
				result: { ok: true },
			}),
		).toEqual({ ok: false, code: "NOT_CLAIMED" });
	});

	test("fail stores an error code and replays idempotently", async () => {
		const repo = new InMemoryConnectorCallRepository();
		const call = await repo.enqueue(enqueueInput());
		await repo.claimNext(DEVICE_A);
		expect(
			await repo.fail({
				callId: call.id,
				deviceId: DEVICE_A,
				errorCode: "RATE_LIMITED",
			}),
		).toEqual({ ok: true, replayed: false });
		expect(
			await repo.fail({
				callId: call.id,
				deviceId: DEVICE_A,
				errorCode: "RATE_LIMITED",
			}),
		).toEqual({ ok: true, replayed: true });
		const stored = repo.peek(call.id);
		expect(stored?.status).toBe("failed");
		expect(stored?.errorCode).toBe("RATE_LIMITED");
		expect(stored?.result).toBeNull();
	});

	test("expireStale expires queued and claimed calls only", async () => {
		let now = new Date("2026-11-01T00:00:00.000Z");
		const repo = new InMemoryConnectorCallRepository({ now: () => now });
		const queued = await repo.enqueue(enqueueInput({ ttlMs: 1_000 }));
		const claimed = await repo.enqueue(enqueueInput({ ttlMs: 1_000 }));
		await repo.claimNext(DEVICE_A);
		const fresh = await repo.enqueue(enqueueInput({ ttlMs: 60_000 }));
		now = new Date("2026-11-01T00:00:05.000Z");
		expect(await repo.expireStale(now)).toBe(2);
		expect(repo.peek(queued.id)?.status).toBe("expired");
		expect(repo.peek(claimed.id)?.status).toBe("expired");
		expect(repo.peek(fresh.id)?.status).toBe("queued");
	});

	test("awaitResult returns terminal outcomes and times out bounded", async () => {
		const repo = new InMemoryConnectorCallRepository();
		const completed = await repo.enqueue(enqueueInput());
		await repo.claimNext(DEVICE_A);
		await repo.complete({
			callId: completed.id,
			deviceId: DEVICE_A,
			result: { issue: "SENTRY-1" },
		});
		expect(await repo.awaitResult(completed.id, 1_000, 10)).toEqual({
			ok: true,
			data: { issue: "SENTRY-1" },
		});

		const failed = await repo.enqueue(enqueueInput());
		await repo.claimNext(DEVICE_A);
		await repo.fail({
			callId: failed.id,
			deviceId: DEVICE_A,
			errorCode: "INTEGRATION_UNAVAILABLE",
		});
		expect(await repo.awaitResult(failed.id, 1_000, 10)).toEqual({
			ok: false,
			errorCode: "INTEGRATION_UNAVAILABLE",
		});

		const pending = await repo.enqueue(enqueueInput());
		expect(await repo.awaitResult(pending.id, 20, 10)).toBeNull();
	});

	test("awaitResult reports an expired call as EXPIRED", async () => {
		let now = new Date("2026-11-01T00:00:00.000Z");
		const repo = new InMemoryConnectorCallRepository({ now: () => now });
		const call = await repo.enqueue(enqueueInput({ ttlMs: 1_000 }));
		now = new Date("2026-11-01T00:00:02.000Z");
		expect(await repo.awaitResult(call.id, 100, 10)).toEqual({
			ok: false,
			errorCode: "EXPIRED",
		});
	});
});

describe("connector call row mapper", () => {
	test("decodes jsonb strings from the Neon pooled endpoint", () => {
		const row: Record<string, unknown> = {
			id: "77777777-7777-4777-8777-777777777777",
			organization_id: ORG_B,
			device_id: DEVICE_A,
			credential_id: CREDENTIAL_A,
			task_id: null,
			connector_id: "sentry",
			tool_name: "sentry.issue_context",
			params: JSON.stringify({ issueId: "SENTRY-1" }),
			status: "completed",
			result: JSON.stringify({ issue: { id: "SENTRY-1" } }),
			error_code: null,
			attempts: 1,
			claimed_at: new Date("2026-11-01T00:00:01.000Z"),
			completed_at: new Date("2026-11-01T00:00:02.000Z"),
			expires_at: new Date("2026-11-01T00:01:00.000Z"),
			created_at: new Date("2026-11-01T00:00:00.000Z"),
		};
		const call = mapConnectorCallRow(row);
		expect(call.params).toEqual({ issueId: "SENTRY-1" });
		expect(call.result).toEqual({ issue: { id: "SENTRY-1" } });
		expect(call.status).toBe("completed");
		expect(call.taskId).toBeNull();
		expect(call.attempts).toBe(1);
	});

	test("rejects a non-object params column", () => {
		expect(() =>
			mapConnectorCallRow({
				id: "77777777-7777-4777-8777-777777777777",
				organization_id: ORG_B,
				device_id: DEVICE_A,
				credential_id: CREDENTIAL_A,
				task_id: null,
				connector_id: "sentry",
				tool_name: "sentry.issue_context",
				params: JSON.stringify(["not", "an", "object"]),
				status: "queued",
				result: null,
				error_code: null,
				attempts: 0,
				claimed_at: null,
				completed_at: null,
				expires_at: new Date("2026-11-01T00:01:00.000Z"),
				created_at: new Date("2026-11-01T00:00:00.000Z"),
			}),
		).toThrow(PlatformError);
	});
});

describe("bounded connector JSON", () => {
	test("refuses credential material and detached clones", () => {
		const token = `github_pat_${"A".repeat(30)}`;
		expect(() =>
			normalizeBoundedConnectorJsonObject(
				{ nested: [{ token }] },
				"probe",
				CONNECTOR_CALL_MAX_RESULT_BYTES,
			),
		).toThrow(PlatformError);
		const source = { list: [{ value: 1 }] };
		const clone = normalizeBoundedConnectorJsonObject(
			source,
			"probe",
			CONNECTOR_CALL_MAX_RESULT_BYTES,
		);
		source.list[0].value = 2;
		expect(clone).toEqual({ list: [{ value: 1 }] });
	});
});
