import { describe, expect, test } from "bun:test";
import {
	clampInboxLimit,
	EVENT_DELIVERY_STATUSES,
	INBOX_LIMITS,
	type InboxTone,
	inboxQuerySchema,
	inboxReasonLabel,
	inboxSeverityLabel,
	inboxSourceLabel,
	inboxStatusLabel,
	inboxStatusTone,
	mapInboxItem,
} from "./contracts";

/**
 * Pure Inbox mapping tests (wave 23). Labels are the only operator-facing
 * projection of delivery status, connector and reason codes.
 */

describe("inbox status labels", () => {
	test("labels every delivery status with a stable tone", () => {
		const expected: Record<string, [string, InboxTone]> = {
			received: ["Received", "neutral"],
			verified: ["Verified", "neutral"],
			rejected: ["Rejected", "attention"],
			deduplicated: ["Deduplicated", "muted"],
			task_created: ["Task created", "positive"],
			task_updated: ["Task updated", "positive"],
			ignored: ["Ignored", "muted"],
		};
		expect(EVENT_DELIVERY_STATUSES).toHaveLength(7);
		for (const status of EVENT_DELIVERY_STATUSES) {
			expect(inboxStatusLabel(status)).toBe(expected[status]?.[0]);
			expect(inboxStatusTone(status)).toBe(expected[status]?.[1]);
		}
	});

	test("unknown values never throw and never echo raw tokens", () => {
		expect(inboxStatusLabel("not-a-status")).toBe("Unknown");
		expect(inboxStatusTone("not-a-status")).toBe("neutral");
		expect(inboxSourceLabel("")).toBe("Source");
		expect(inboxSourceLabel("custom-source")).toBe("Custom-source");
		expect(inboxSeverityLabel("urgent")).toBe("Info");
	});
});

describe("inbox connector and reason labels", () => {
	test("maps known connectors and bounds unknown tokens", () => {
		expect(inboxSourceLabel("github")).toBe("GitHub");
		expect(inboxSourceLabel("pagerduty")).toBe("PagerDuty");
		expect(inboxSourceLabel("generic")).toBe("Signed webhook");
		expect(inboxSourceLabel("a".repeat(80)).length).toBeLessThanOrEqual(32);
	});

	test("maps reason codes and humanizes unknown ones", () => {
		expect(inboxReasonLabel(null)).toBeNull();
		expect(inboxReasonLabel("AUTONOMY_LEVEL_UNSUPPORTED")).toBe(
			"Autonomy level not supported yet",
		);
		expect(inboxReasonLabel("SOMETHING_NEW")).toBe("Something new");
	});
});

describe("inbox limits and query validation", () => {
	test("clamps the limit to 1..100 with a default of 25", () => {
		expect(INBOX_LIMITS).toEqual({ default: 25, max: 100 });
		expect(clampInboxLimit(undefined)).toBe(25);
		expect(clampInboxLimit(0)).toBe(1);
		expect(clampInboxLimit(500)).toBe(100);
		expect(clampInboxLimit(42.9)).toBe(42);
	});

	test("accepts bounded filters and rejects malformed ones", () => {
		expect(inboxQuerySchema.safeParse({ limit: 10 }).success).toBe(true);
		expect(
			inboxQuerySchema.safeParse({ source: "github", status: "task_created" })
				.success,
		).toBe(true);
		expect(inboxQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
		// Oversized limits are accepted and clamped by the read model.
		expect(inboxQuerySchema.safeParse({ limit: 101 }).success).toBe(true);
		expect(inboxQuerySchema.safeParse({ source: "GitHub" }).success).toBe(
			false,
		);
		expect(inboxQuerySchema.safeParse({ status: "unknown" }).success).toBe(
			false,
		);
		expect(inboxQuerySchema.safeParse({ extra: true }).success).toBe(false);
	});
});

describe("mapInboxItem", () => {
	test("adds labels without adding payload fields", () => {
		const item = mapInboxItem({
			id: "delivery-1",
			connector: "github",
			source: "github",
			eventKind: "workflow_failed",
			severity: "critical",
			status: "task_created",
			reasonCode: null,
			title: "CI failed on main",
			summary: "The integration job failed.",
			links: [
				{
					label: "Workflow run",
					url: "https://github.com/owner/checkout/actions/runs/42",
				},
			],
			repository: "owner/checkout",
			taskId: "33333333-3333-4333-8333-333333333333",
			receivedAt: "2026-11-20T12:00:00.000Z",
			processedAt: "2026-11-20T12:00:01.000Z",
		});
		expect(item.statusLabel).toBe("Task created");
		expect(item.sourceLabel).toBe("GitHub");
		expect(item.severityLabel).toBe("Critical");
		expect(item.reasonLabel).toBeNull();
		const forbidden = [
			"payload",
			"rawBody",
			"bodySha256",
			"headers",
			"token",
			"secret",
		];
		for (const key of forbidden) expect(Object.hasOwn(item, key)).toBe(false);
	});
});
