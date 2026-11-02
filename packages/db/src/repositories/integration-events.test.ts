import { describe, expect, test } from "bun:test";
import type { RepositoryId, UserId } from "@isolate/shared";
import { asOrganizationId, PlatformError } from "@isolate/shared";
import type { PgSql } from "../client";
import {
	InMemoryEventDeliveryRepository,
	InMemoryGitHubInstallationRepository,
	InMemoryIntegrationSubscriptionRepository,
} from "../testing/integration-events-fakes";
import {
	decodeDeliveryCursor,
	encodeDeliveryCursor,
	MAX_DELIVERY_PAGE_LIMIT,
	normalizeEventDeliveryInput,
} from "./event-deliveries";
import {
	MAX_INCIDENT_SUMMARY_DB_CHARS,
	MAX_INCIDENT_TITLE_DB_CHARS,
	normalizeIncidentSignalInput,
	PostgresIncidentRepository,
} from "./incident-repository";
import { severityAtLeast, severityRank } from "./integration-subscriptions";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const USER = "33333333-3333-4333-8333-333333333333" as UserId;
const REPO = "44444444-4444-4444-8444-444444444444" as RepositoryId;
const SHA = "a".repeat(64);
const BASE = new Date("2026-11-02T12:00:00.000Z");

function tickingClock(): () => Date {
	let tick = 0;
	return () => new Date(BASE.getTime() + tick++ * 1000);
}

function installation(
	overrides: Partial<
		Parameters<InMemoryGitHubInstallationRepository["upsert"]>[0]
	> = {},
) {
	return {
		organizationId: ORG_A,
		installationId: "987654",
		accountLogin: "acme",
		accountType: "Organization" as const,
		repositorySelection: "selected" as const,
		createdBy: USER,
		...overrides,
	};
}

function subscription(
	overrides: Partial<
		Parameters<InMemoryIntegrationSubscriptionRepository["create"]>[0]
	> = {},
) {
	return {
		organizationId: ORG_A,
		connectorId: "github" as const,
		displayName: "Failed workflows",
		eventKinds: ["workflow_run.failed"],
		environmentAllowlist: ["production"],
		minSeverity: "high" as const,
		repositoryId: REPO,
		baseBranch: "main",
		autonomyLevel: "A2" as const,
		enabled: true,
		config: {},
		createdBy: USER,
		...overrides,
	};
}

function delivery(
	overrides: Partial<
		Parameters<InMemoryEventDeliveryRepository["record"]>[0]
	> = {},
) {
	return {
		organizationId: ORG_A,
		connectorId: "github" as const,
		deliveryId: "delivery-1",
		source: "github",
		eventKind: "workflow_run.failed",
		severity: "critical" as const,
		fingerprint: "repo:acme/widgets:run:42",
		verification: "provider_signature" as const,
		bodySha256: SHA,
		receivedAt: BASE,
		...overrides,
	};
}

describe("GitHub installations", () => {
	test("upsert is tenant-scoped and refreshes an existing installation", async () => {
		const repo = new InMemoryGitHubInstallationRepository(tickingClock());
		const created = await repo.upsert(installation());
		if (created === null) throw new Error("installation was not created");
		expect(created.installation_id).toBe("987654");
		expect(created.status).toBe("active");
		const refreshed = await repo.upsert(
			installation({ repositorySelection: "all", accountLogin: "acme-org" }),
		);
		expect(refreshed?.id).toBe(created?.id);
		expect(refreshed?.repository_selection).toBe("all");
		expect(refreshed?.account_login).toBe("acme-org");
		expect(repo.rowCount).toBe(1);
	});

	test("a different tenant can never take over a numeric installation id", async () => {
		const repo = new InMemoryGitHubInstallationRepository();
		expect(await repo.upsert(installation())).not.toBeNull();
		expect(
			await repo.upsert(installation({ organizationId: ORG_B })),
		).toBeNull();
		expect(await repo.findByOrganization(ORG_B, "987654")).toBeNull();
		expect(
			(await repo.findByOrganization(ORG_A, "987654"))?.organization_id,
		).toBe(ORG_A);
	});

	test("active lookup, list and revoke stay inside one tenant", async () => {
		const repo = new InMemoryGitHubInstallationRepository(tickingClock());
		await repo.upsert(installation({ installationId: "1" }));
		await repo.upsert(installation({ installationId: "2" }));
		await repo.upsert(
			installation({ organizationId: ORG_B, installationId: "3" }),
		);
		expect((await repo.list(ORG_A)).map((row) => row.installation_id)).toEqual([
			"2",
			"1",
		]);
		expect(await repo.list(ORG_B)).toHaveLength(1);
		expect((await repo.findActiveByOrganization(ORG_A))?.installation_id).toBe(
			"2",
		);
		expect(await repo.revoke(ORG_B, "1")).toBeNull();
		expect((await repo.revoke(ORG_A, "1"))?.status).toBe("revoked");
		expect((await repo.findActiveByOrganization(ORG_A))?.installation_id).toBe(
			"2",
		);
		expect(await repo.revoke(ORG_A, "1")).not.toBeNull();
	});

	test("rejects malformed installation ids, logins and enums", async () => {
		const repo = new InMemoryGitHubInstallationRepository();
		for (const installationId of ["", "0", "-1", "12ab", "1".repeat(21)]) {
			await expect(
				repo.upsert(installation({ installationId })),
			).rejects.toBeInstanceOf(Error);
		}
		await expect(
			repo.upsert(installation({ accountLogin: " bad\nlogin " })),
		).rejects.toBeInstanceOf(Error);
		await expect(
			repo.upsert(installation({ accountType: "Bot" as never })),
		).rejects.toBeInstanceOf(Error);
	});
});

describe("integration subscriptions", () => {
	test("create/list apply shared defaults and stay tenant-scoped", async () => {
		const repo = new InMemoryIntegrationSubscriptionRepository();
		const created = await repo.create({
			organizationId: ORG_A,
			connectorId: "github",
			displayName: "Minimal",
		} as never);
		expect(created.environment_allowlist).toEqual(["production"]);
		expect(created.min_severity).toBe("high");
		expect(created.autonomy_level).toBe("A2");
		expect(created.repository_id).toBeNull();
		await repo.create(subscription({ organizationId: ORG_B }));
		expect(await repo.list(ORG_A)).toHaveLength(1);
		expect(await repo.list(ORG_B)).toHaveLength(1);
		expect(await repo.list(ORG_A, "sentry")).toHaveLength(0);
	});

	test("duplicate names inside one connector are refused, across tenants allowed", async () => {
		const repo = new InMemoryIntegrationSubscriptionRepository();
		await repo.create(subscription());
		await expect(repo.create(subscription())).rejects.toBeInstanceOf(Error);
		await expect(
			repo.create(subscription({ organizationId: ORG_B })),
		).resolves.toBeDefined();
	});

	test("update, setEnabled and delete are tenant-scoped", async () => {
		const repo = new InMemoryIntegrationSubscriptionRepository();
		const created = await repo.create(subscription());
		expect(
			await repo.update({
				organizationId: ORG_B,
				id: created.id,
				displayName: "Stolen",
			}),
		).toBeNull();
		const updated = await repo.update({
			organizationId: ORG_A,
			id: created.id,
			displayName: "Renamed",
			autonomyLevel: "A3",
			config: { branchPrefix: "isolate/" },
		});
		expect(updated?.display_name).toBe("Renamed");
		expect(updated?.autonomy_level).toBe("A3");
		expect(updated?.config).toEqual({ branchPrefix: "isolate/" });
		expect(await repo.setEnabled(ORG_B, created.id, false)).toBeNull();
		expect((await repo.setEnabled(ORG_A, created.id, false))?.enabled).toBe(
			false,
		);
		expect(await repo.delete(ORG_B, created.id)).toBe(false);
		expect(await repo.delete(ORG_A, created.id)).toBe(true);
		expect(await repo.delete(ORG_A, created.id)).toBe(false);
	});

	test("matching follows kind, environment, severity and enabled state", async () => {
		const repo = new InMemoryIntegrationSubscriptionRepository();
		const strict = await repo.create(subscription());
		const wildcard = await repo.create(
			subscription({
				displayName: "All sentry issues",
				connectorId: "sentry",
				eventKinds: [],
				environmentAllowlist: ["production", "staging"],
				minSeverity: "medium",
			}),
		);
		const match = {
			organizationId: ORG_A,
			connectorId: "github" as const,
			environment: "production",
		};
		expect(
			(
				await repo.findMatchingForEvent({
					...match,
					eventKind: "workflow_run.failed",
					severity: "critical",
				})
			).map((row) => row.id),
		).toEqual([strict.id]);
		expect(
			await repo.findMatchingForEvent({
				...match,
				eventKind: "workflow_run.failed",
				severity: "low",
			}),
		).toEqual([]);
		expect(
			await repo.findMatchingForEvent({
				...match,
				environment: "staging",
				eventKind: "workflow_run.failed",
				severity: "critical",
			}),
		).toEqual([]);
		expect(
			await repo.findMatchingForEvent({
				...match,
				eventKind: "check_suite.failed",
				severity: "critical",
			}),
		).toEqual([]);
		expect(
			await repo.findMatchingForEvent({
				organizationId: ORG_A,
				connectorId: "sentry",
				environment: "staging",
				eventKind: "issue.created",
				severity: "medium",
			}),
		).toEqual([wildcard]);
		await repo.setEnabled(ORG_A, strict.id, false);
		expect(
			await repo.findMatchingForEvent({
				...match,
				eventKind: "workflow_run.failed",
				severity: "critical",
			}),
		).toEqual([]);
		expect(
			await repo.findMatchingForEvent({
				organizationId: ORG_B,
				connectorId: "github",
				environment: "production",
				eventKind: "workflow_run.failed",
				severity: "critical",
			}),
		).toEqual([]);
	});

	test("pure severity helpers rank info..critical", () => {
		expect(severityRank("critical")).toBe(4);
		expect(severityRank("info")).toBe(0);
		expect(severityAtLeast("critical", "high")).toBe(true);
		expect(severityAtLeast("medium", "high")).toBe(false);
		expect(() => severityRank("urgent" as never)).toThrow(PlatformError);
	});
});

describe("event deliveries", () => {
	test("records idempotently by tenant, connector and delivery id", async () => {
		const repo = new InMemoryEventDeliveryRepository();
		const first = await repo.record(delivery());
		expect(first.created).toBe(true);
		const replay = await repo.record(delivery({ bodySha256: "b".repeat(64) }));
		expect(replay.created).toBe(false);
		expect(replay.delivery.id).toBe(first.delivery.id);
		expect(repo.rowCount).toBe(1);
		// Another tenant's identical delivery id is a distinct receipt.
		const otherTenant = await repo.record(delivery({ organizationId: ORG_B }));
		expect(otherTenant.created).toBe(true);
		expect(otherTenant.delivery.id).not.toBe(first.delivery.id);
		expect(repo.rowCount).toBe(2);
		// A null delivery id is always a new receipt.
		await repo.record(delivery({ deliveryId: null }));
		await repo.record(delivery({ deliveryId: null }));
		expect(repo.rowCount).toBe(4);
	});

	test("updateStatus is tenant-scoped and validates the status", async () => {
		const repo = new InMemoryEventDeliveryRepository();
		const recorded = await repo.record(delivery());
		expect(
			await repo.updateStatus({
				organizationId: ORG_B,
				id: recorded.delivery.id,
				status: "rejected",
			}),
		).toBeNull();
		const updated = await repo.updateStatus({
			organizationId: ORG_A,
			id: recorded.delivery.id,
			status: "rejected",
			reasonCode: "SIGNATURE_INVALID",
			processedAt: new Date("2026-11-02T12:05:00.000Z"),
		});
		expect(updated?.status).toBe("rejected");
		expect(updated?.reason_code).toBe("SIGNATURE_INVALID");
		expect(updated?.processed_at).toEqual(new Date("2026-11-02T12:05:00.000Z"));
		await expect(
			repo.updateStatus({
				organizationId: ORG_A,
				id: recorded.delivery.id,
				status: "delivered" as never,
			}),
		).rejects.toBeInstanceOf(PlatformError);
	});

	test("lists are bounded, newest-first and keyset-paginated", async () => {
		const repo = new InMemoryEventDeliveryRepository();
		for (let index = 0; index < 5; index += 1) {
			await repo.record(
				delivery({
					deliveryId: `delivery-${index}`,
					receivedAt: new Date(BASE.getTime() + index * 1000),
				}),
			);
		}
		const firstPage = await repo.listInbox({
			organizationId: ORG_A,
			limit: 2,
		});
		expect(firstPage.items.map((row) => row.delivery_id)).toEqual([
			"delivery-4",
			"delivery-3",
		]);
		expect(firstPage.nextCursor).not.toBeNull();
		const secondPage = await repo.listInbox({
			organizationId: ORG_A,
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage.items.map((row) => row.delivery_id)).toEqual([
			"delivery-2",
			"delivery-1",
		]);
		const thirdPage = await repo.listInbox({
			organizationId: ORG_A,
			limit: 2,
			cursor: secondPage.nextCursor,
		});
		expect(thirdPage.items.map((row) => row.delivery_id)).toEqual([
			"delivery-0",
		]);
		expect(thirdPage.nextCursor).toBeNull();
		// A filter narrows the page; another tenant sees nothing.
		await repo.updateStatus({
			organizationId: ORG_A,
			id: firstPage.items[0].id,
			status: "task_created",
		});
		expect(
			(
				await repo.listInbox({
					organizationId: ORG_A,
					status: "task_created",
					limit: 10,
				})
			).items,
		).toHaveLength(1);
		expect(
			(
				await repo.listInbox({
					organizationId: ORG_B,
					limit: 10,
				})
			).items,
		).toEqual([]);
		const recent = await repo.listRecent({
			organizationId: ORG_A,
			connectorId: "github",
			limit: MAX_DELIVERY_PAGE_LIMIT,
		});
		expect(recent.items).toHaveLength(5);
	});

	test("cursors and inputs are validated", async () => {
		expect(() => decodeDeliveryCursor("not-a-cursor")).toThrow(PlatformError);
		const valid = encodeDeliveryCursor({
			receivedAt: BASE,
			id: crypto.randomUUID(),
		});
		const decoded = decodeDeliveryCursor(valid);
		expect(decoded.receivedAt).toEqual(BASE);
		expect(decoded.id).toMatch(/^[0-9a-f-]{36}$/);
		const repo = new InMemoryEventDeliveryRepository();
		await expect(
			repo.listInbox({ organizationId: ORG_A, cursor: "bad" }),
		).rejects.toBeInstanceOf(PlatformError);
		expect(() =>
			normalizeEventDeliveryInput(delivery({ connectorId: "Sentry" as never })),
		).toThrow(PlatformError);
		expect(() =>
			normalizeEventDeliveryInput(delivery({ bodySha256: "not-a-hash" })),
		).toThrow(PlatformError);
		expect(() =>
			normalizeEventDeliveryInput(delivery({ severity: "urgent" as never })),
		).toThrow(PlatformError);
	});
});

describe("incident signal display fields (0016)", () => {
	const signal = {
		organizationId: ORG_A,
		source: "github",
		kind: "workflow_run.failed",
		severity: "critical" as const,
		service: "checkout",
		fingerprint: "repo:acme/checkout:run:42",
		deliveryId: "delivery-1",
		title: "  Checkout workflow failed  ",
		summary: "Run 42 failed on main after 3 minutes.",
		links: [
			{ label: "Run", url: "https://github.com/acme/checkout/actions/runs/42" },
		],
		occurrenceCount: 2,
		receivedAt: BASE,
	};

	test("normalizes bounded display evidence and defaults", () => {
		const parsed = normalizeIncidentSignalInput(signal);
		expect(parsed.title).toBe("Checkout workflow failed");
		expect(parsed.summary).toBe(signal.summary);
		expect(parsed.links).toHaveLength(1);
		expect(parsed.occurrenceCount).toBe(2);
		const minimal = normalizeIncidentSignalInput({
			organizationId: ORG_A,
			source: "github",
			kind: "workflow_run.failed",
			severity: "high",
			service: "checkout",
			fingerprint: "repo:acme/checkout:run:43",
			receivedAt: BASE,
		});
		expect(minimal.title).toBe("");
		expect(minimal.summary).toBe("");
		expect(minimal.links).toEqual([]);
		expect(minimal.occurrenceCount).toBe(1);
	});

	test("rejects oversize title/summary, too many links and bad counts", () => {
		expect(() =>
			normalizeIncidentSignalInput({
				...signal,
				title: "x".repeat(MAX_INCIDENT_TITLE_DB_CHARS + 1),
			}),
		).toThrow(/title/);
		expect(() =>
			normalizeIncidentSignalInput({
				...signal,
				summary: "x".repeat(MAX_INCIDENT_SUMMARY_DB_CHARS + 1),
			}),
		).toThrow(/summary/);
		expect(() =>
			normalizeIncidentSignalInput({
				...signal,
				links: Array.from({ length: 11 }, () => signal.links[0]),
			}),
		).toThrow(/links/);
		expect(() =>
			normalizeIncidentSignalInput({
				...signal,
				links: [{ label: "Run", url: "http://insecure.example" }],
			}),
		).toThrow(/links/);
		for (const occurrenceCount of [0, -1, 1.5]) {
			expect(() =>
				normalizeIncidentSignalInput({ ...signal, occurrenceCount }),
			).toThrow(/occurrenceCount/);
		}
	});

	test("the Postgres writer persists the columns and advances occurrences on dedupe", async () => {
		const calls: { query: string; params: readonly unknown[] }[] = [];
		let insert = true;
		const sql = {
			unsafe: async (query: string, params: readonly unknown[] = []) => {
				calls.push({ query, params });
				if (query.includes("INSERT INTO incident_signals")) {
					return insert ? [{ id: "signal-1" }] : [];
				}
				if (query.includes("SELECT id FROM incident_signals")) {
					return [{ id: "signal-1" }];
				}
				return [{ id: "signal-1" }];
			},
		} as unknown as PgSql;
		const repo = new PostgresIncidentRepository(sql);
		const first = await repo.recordIfNew(signal);
		expect(first).toEqual({ ok: true, signalId: "signal-1", created: true });
		const insertCall = calls[0];
		expect(insertCall.query).toContain("occurrence_count");
		expect(insertCall.params[7]).toBe("Checkout workflow failed");
		expect(insertCall.params[8]).toBe(signal.summary);
		expect(insertCall.params[9]).toBe(JSON.stringify(signal.links));
		expect(insertCall.params[10]).toBe(2);

		// A duplicate delivery finds the surviving row and increments its count.
		calls.length = 0;
		insert = false;
		const replay = await repo.recordIfNew(signal);
		expect(replay).toEqual({
			ok: true,
			signalId: "signal-1",
			created: false,
		});
		const touch = calls.find((call) =>
			call.query.includes("occurrence_count = occurrence_count + 1"),
		);
		expect(touch).toBeDefined();
		expect(touch?.params).toEqual([
			ORG_A,
			"signal-1",
			"github",
			"Checkout workflow failed",
			signal.summary,
			JSON.stringify(signal.links),
		]);
	});
});
