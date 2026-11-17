import { describe, expect, test } from "bun:test";
import { asOrganizationId, asUserId } from "@isolate/shared";
import type { InboxDeliveryRow } from "../features/inbox/contracts";
import { UiInvalidInputError } from "../features/ui/contracts";
import {
	createInboxReadService,
	type InboxFilter,
	type InboxReadRepository,
	parseInboxLinks,
} from "./inbox-read.server";
import type { CallerScope } from "./task-service.server";

/**
 * Inbox read-model tests (wave 23): bounded caps, tenant passthrough, filters
 * and the absence of payload material in the returned projection.
 */

const ORG = asOrganizationId("11111111-1111-4111-8111-111111111111");
const OTHER_ORG = asOrganizationId("22222222-2222-4222-8222-222222222222");
const USER = asUserId("33333333-3333-4333-8333-333333333333");

function scope(organizationId = ORG): CallerScope {
	return { organizationId, userId: USER, role: "owner" };
}

function row(index: number): InboxDeliveryRow {
	return {
		id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		connector: "github",
		source: "github",
		eventKind: "workflow_failed",
		severity: "critical",
		status: "task_created",
		reasonCode: null,
		title: `Failure ${index}`,
		summary: "",
		links: [],
		repository: "owner/checkout",
		taskId: null,
		receivedAt: new Date(1_800_000_000_000 - index * 1000).toISOString(),
		processedAt: null,
	};
}

function fakeRepository(rows: InboxDeliveryRow[]): {
	repository: InboxReadRepository;
	calls: Array<{ scope: CallerScope; filter: InboxFilter }>;
} {
	const calls: Array<{ scope: CallerScope; filter: InboxFilter }> = [];
	return {
		repository: {
			async listDeliveries(caller, filter) {
				calls.push({ scope: caller, filter });
				return rows.slice(0, filter.limit);
			},
		},
		calls,
	};
}

const manyRows = Array.from({ length: 150 }, (_, index) => row(index));

describe("inbox read model", () => {
	test("defaults to 25 and caps at 100", async () => {
		const fake = fakeRepository(manyRows);
		const service = createInboxReadService(fake.repository);

		const page = await service.listInbox(scope());
		expect(page.limit).toBe(25);
		expect(page.items).toHaveLength(25);

		const capped = await service.listInbox(scope(), { limit: 500 });
		expect(capped.limit).toBe(100);
		expect(capped.items).toHaveLength(100);

		expect(fake.calls.map((call) => call.filter.limit)).toEqual([25, 100]);
	});

	test("passes the caller organization and filters through", async () => {
		const fake = fakeRepository(manyRows);
		const service = createInboxReadService(fake.repository);
		await service.listInbox(scope(OTHER_ORG), {
			limit: 10,
			source: "sentry",
			status: "ignored",
		});
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.scope.organizationId).toBe(OTHER_ORG);
		expect(fake.calls[0]?.filter).toEqual({
			limit: 10,
			connector: "sentry",
			status: "ignored",
			severity: null,
		});
	});

	test("severity reaches the repository as a filter", async () => {
		const fake = fakeRepository(manyRows);
		const service = createInboxReadService(fake.repository);
		await service.listInbox(scope(), { severity: "critical" });
		expect(fake.calls[0]?.filter.severity).toBe("critical");
	});

	test("rejects malformed queries before touching storage", async () => {
		const fake = fakeRepository(manyRows);
		const service = createInboxReadService(fake.repository);
		for (const query of [
			{ limit: 0 },
			{ source: "Sentry" },
			{ status: "not-a-status" },
			{ payload: "x" },
		]) {
			await expect(service.listInbox(scope(), query)).rejects.toBeInstanceOf(
				UiInvalidInputError,
			);
		}
		expect(fake.calls).toHaveLength(0);
	});

	test("returns labels and no payload, hash, header or token field", async () => {
		const service = createInboxReadService(fakeRepository([row(1)]).repository);
		const page = await service.listInbox(scope());
		const item = page.items[0];
		expect(item?.statusLabel).toBe("Task created");
		expect(item?.sourceLabel).toBe("GitHub");
		expect(item?.severityLabel).toBe("Critical");
		const serialized = JSON.stringify(page);
		for (const marker of ["payload", "bodySha256", "signature", "secret"])
			expect(serialized).not.toContain(marker);
		const allowed = new Set([
			"id",
			"connector",
			"source",
			"eventKind",
			"severity",
			"status",
			"reasonCode",
			"title",
			"summary",
			"links",
			"repository",
			"taskId",
			"receivedAt",
			"processedAt",
			"statusLabel",
			"statusTone",
			"sourceLabel",
			"reasonLabel",
			"severityLabel",
		]);
		for (const key of Object.keys(item ?? {}))
			expect(allowed.has(key)).toBe(true);
	});

	test("preserves newest-first repository order", async () => {
		const service = createInboxReadService(fakeRepository(manyRows).repository);
		const page = await service.listInbox(scope(), { limit: 5 });
		expect(page.items.map((item) => item.title)).toEqual([
			"Failure 0",
			"Failure 1",
			"Failure 2",
			"Failure 3",
			"Failure 4",
		]);
	});
});

describe("parseInboxLinks", () => {
	test("keeps only bounded https links and caps the list", () => {
		const valid = {
			label: "Run",
			url: "https://github.com/owner/repo/actions/runs/1",
		};
		expect(parseInboxLinks("not json")).toEqual([]);
		expect(parseInboxLinks(null)).toEqual([]);
		expect(parseInboxLinks([valid])).toEqual([valid]);
		expect(
			parseInboxLinks([{ label: "Run", url: "http://insecure.example.com" }]),
		).toEqual([]);
		expect(
			parseInboxLinks([{ label: "Run", url: "https://user:pass@example.com" }]),
		).toEqual([]);
		const many = Array.from({ length: 20 }, (_, index) => ({
			label: `Run ${index}`,
			url: `https://example.com/${index}`,
		}));
		expect(parseInboxLinks(many)).toHaveLength(10);
	});
});
