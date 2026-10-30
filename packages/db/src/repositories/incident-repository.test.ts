import { expect, test } from "bun:test";
import { asOrganizationId } from "@isolate/shared";
import {
	InMemoryIncidentRepository,
	InMemoryTaskRepository,
} from "../testing/fakes";
import {
	INCIDENT_DEDUPE_WINDOW_MS,
	type IncidentSignalInput,
	incidentDedupeBucketStart,
	normalizeIncidentMetadata,
	normalizeIncidentSignalInput,
} from "./incident-repository";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const REPO = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

/** 12:00:00Z, inside the [12:00, 12:30) bucket. */
const BASE = new Date("2026-10-30T12:00:00.000Z");

function signal(
	overrides: Partial<IncidentSignalInput> = {},
): IncidentSignalInput {
	return {
		organizationId: ORG_A,
		source: "github",
		kind: "workflow_run.failed",
		severity: "critical",
		service: "checkout",
		fingerprint: "repo:owner/checkout:run:42",
		deliveryId: "delivery-1",
		receivedAt: BASE,
		...overrides,
	};
}

function tasksRepo(): InMemoryTaskRepository {
	return new InMemoryTaskRepository();
}

function createTask(
	tasks: InMemoryTaskRepository,
	input: {
		organizationId?: typeof ORG_A;
		idempotencyKey: string;
		incidentSource?: string;
		incidentFingerprint?: string;
	} = { idempotencyKey: "key" },
) {
	return tasks.create({
		organizationId: input.organizationId ?? ORG_A,
		repositoryId: REPO,
		branch: `task/${input.idempotencyKey}`,
		idempotencyKey: input.idempotencyKey,
		budgetLimits: {
			maxAgentTurns: 5,
			maxRepairAttempts: 1,
			maxDurationMs: 600000,
		},
		incidentSource: input.incidentSource,
		incidentFingerprint: input.incidentFingerprint,
		createdBy: USER,
	});
}

test("recordIfNew dedupes a second delivery inside the same 30-minute bucket", async () => {
	const repo = new InMemoryIncidentRepository(tasksRepo());
	const first = await repo.recordIfNew(signal());
	expect(first.created).toBe(true);

	// 29 minutes later is still the same bucket.
	const second = await repo.recordIfNew(
		signal({
			deliveryId: "delivery-2",
			receivedAt: new Date(BASE.getTime() + 29 * 60 * 1000),
		}),
	);
	expect(second).toEqual({
		ok: true,
		signalId: first.signalId,
		created: false,
	});
	expect(repo.signalCount).toBe(1);
});

test("a delivery in the next bucket creates a second row", async () => {
	const repo = new InMemoryIncidentRepository(tasksRepo());
	const first = await repo.recordIfNew(signal());
	const next = await repo.recordIfNew(
		signal({ receivedAt: new Date(BASE.getTime() + 31 * 60 * 1000) }),
	);
	expect(next.created).toBe(true);
	expect(next.signalId).not.toBe(first.signalId);
	expect(repo.signalCount).toBe(2);
});

test("dedupe is tenant-scoped and keys on source as well as fingerprint", async () => {
	const repo = new InMemoryIncidentRepository(tasksRepo());
	const a = await repo.recordIfNew(signal());
	const b = await repo.recordIfNew(signal({ organizationId: ORG_B }));
	expect(b.created).toBe(true);
	expect(b.signalId).not.toBe(a.signalId);

	// Same fingerprint and bucket, different source: a distinct signal.
	const sentry = await repo.recordIfNew(signal({ source: "sentry" }));
	expect(sentry.created).toBe(true);
	expect(repo.signalCount).toBe(3);

	// The original tenant replay still resolves to the first row.
	const replay = await repo.recordIfNew(signal());
	expect(replay.signalId).toBe(a.signalId);
	expect(replay.created).toBe(false);
});

test("bucket helper floors timestamps to the 30-minute boundary", () => {
	expect(incidentDedupeBucketStart(BASE)).toBe(BASE.getTime());
	expect(
		incidentDedupeBucketStart(
			new Date(BASE.getTime() + INCIDENT_DEDUPE_WINDOW_MS - 1),
		),
	).toBe(BASE.getTime());
	expect(
		incidentDedupeBucketStart(
			new Date(BASE.getTime() + INCIDENT_DEDUPE_WINDOW_MS),
		),
	).toBe(BASE.getTime() + INCIDENT_DEDUPE_WINDOW_MS);
});

test("countActiveIncidentTasks respects window, sources, tenant and fingerprint", async () => {
	const tasks = tasksRepo();
	const repo = new InMemoryIncidentRepository(tasks);
	await createTask(tasks, {
		idempotencyKey: "inc-1",
		incidentSource: "github",
		incidentFingerprint: "fp-1",
	});
	await createTask(tasks, {
		idempotencyKey: "inc-2",
		incidentSource: "github",
		incidentFingerprint: "fp-2",
	});
	await createTask(tasks, {
		idempotencyKey: "inc-sentry",
		incidentSource: "sentry",
		incidentFingerprint: "fp-3",
	});
	await createTask(tasks, { idempotencyKey: "plain" });
	await createTask(tasks, {
		organizationId: ORG_B,
		idempotencyKey: "foreign",
		incidentSource: "github",
		incidentFingerprint: "fp-4",
	});

	const since = new Date(Date.now() - 60 * 60 * 1000);
	expect(
		await repo.countActiveIncidentTasks({
			organizationId: ORG_A,
			since,
			sources: ["github"],
		}),
	).toBe(2);
	expect(
		await repo.countActiveIncidentTasks({
			organizationId: ORG_A,
			since,
			sources: ["github", "sentry"],
		}),
	).toBe(3);
	// Window: a since in the future counts nothing.
	expect(
		await repo.countActiveIncidentTasks({
			organizationId: ORG_A,
			since: new Date(Date.now() + 1000),
			sources: ["github"],
		}),
	).toBe(0);
	// No eligible source: the cap sees nothing.
	expect(
		await repo.countActiveIncidentTasks({
			organizationId: ORG_A,
			since,
			sources: [],
		}),
	).toBe(0);
});

test("normalizeIncidentSignalInput rejects oversize and empty fields", () => {
	expect(() =>
		normalizeIncidentSignalInput(signal({ source: "x".repeat(33) })),
	).toThrow("source must be at most 32 characters");
	expect(() =>
		normalizeIncidentSignalInput(signal({ fingerprint: "f".repeat(129) })),
	).toThrow("fingerprint must be at most 128 characters");
	expect(() => normalizeIncidentSignalInput(signal({ kind: "   " }))).toThrow(
		"kind must be a non-empty string",
	);
	expect(() =>
		normalizeIncidentSignalInput(
			signal({ severity: "urgent" as IncidentSignalInput["severity"] }),
		),
	).toThrow("severity must be one of");
	expect(() =>
		normalizeIncidentSignalInput(signal({ receivedAt: new Date(Number.NaN) })),
	).toThrow("receivedAt must be a valid Date");
	// Trimming keeps the dedupe identity stable for padded provider values.
	expect(
		normalizeIncidentSignalInput(
			signal({ service: "  checkout  ", deliveryId: "  d1 " }),
		),
	).toMatchObject({ service: "checkout", deliveryId: "d1" });
});

test("task create stores incident metadata as a pair and retry copies it", async () => {
	const tasks = tasksRepo();
	const created = await createTask(tasks, {
		idempotencyKey: "incident-task",
		incidentSource: " github ",
		incidentFingerprint: "repo:owner/checkout:run:42",
	});
	expect(created.incident_source).toBe("github");
	expect(created.incident_fingerprint).toBe("repo:owner/checkout:run:42");

	const plain = await createTask(tasks, { idempotencyKey: "plain-task" });
	expect(plain.incident_source).toBeNull();
	expect(plain.incident_fingerprint).toBeNull();

	await tasks.transition({
		taskId: created.id,
		to: "failed",
		expectedStatus: "queued",
	});
	const retry = await tasks.createRetry({
		organizationId: ORG_A,
		failedTaskId: created.id,
		idempotencyKey: "incident-retry",
	});
	expect(retry.ok).toBe(true);
	if (!retry.ok) return;
	expect(retry.task.incident_source).toBe("github");
	expect(retry.task.incident_fingerprint).toBe("repo:owner/checkout:run:42");
});

test("incident metadata is all-or-nothing and bounded", async () => {
	expect(
		normalizeIncidentMetadata({
			incidentSource: "github",
			incidentFingerprint: "fp",
		}),
	).toEqual({ incidentSource: "github", incidentFingerprint: "fp" });
	expect(normalizeIncidentMetadata({})).toEqual({
		incidentSource: null,
		incidentFingerprint: null,
	});
	expect(() => normalizeIncidentMetadata({ incidentSource: "github" })).toThrow(
		"must be provided together",
	);
	expect(() =>
		normalizeIncidentMetadata({ incidentFingerprint: "fp" }),
	).toThrow("must be provided together");
	expect(() =>
		normalizeIncidentMetadata({
			incidentSource: "x".repeat(33),
			incidentFingerprint: "fp",
		}),
	).toThrow("incidentSource must be at most 32 characters");
	expect(() =>
		normalizeIncidentMetadata({
			incidentSource: "github",
			incidentFingerprint: "f".repeat(129),
		}),
	).toThrow("incidentFingerprint must be at most 128 characters");

	const tasks = tasksRepo();
	await expect(
		createTask(tasks, {
			idempotencyKey: "half-pair",
			incidentSource: "github",
		}),
	).rejects.toThrow("must be provided together");
});
