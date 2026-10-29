import { describe, expect, test } from "bun:test";
import { asOrganizationId, asUserId } from "@isolate/shared";
import {
	type ActiveMembership,
	createLocalDemoAdapters,
	localDemo,
	type MembershipReader,
	type RuntimeConfig,
	resolveCallerScope,
	type SessionResolver,
} from "./caller-scope.server";
import { createTaskService } from "./task-service.server";
import {
	scope as demoScope,
	harness,
	input,
	otherScope,
} from "./test-fixtures";

const orgA = asOrganizationId("40000000-0000-4000-8000-000000000001");
const orgB = asOrganizationId("40000000-0000-4000-8000-000000000002");
const userA = asUserId("40000000-0000-4000-8000-000000000003");
const userB = asUserId("40000000-0000-4000-8000-000000000004");
const repoA = "40000000-0000-4000-8000-000000000005";
const repoB = "40000000-0000-4000-8000-000000000006";

function sessionOf(userId: string | null, throws = false): SessionResolver {
	return {
		async getSession() {
			if (throws) throw new Error("private session fixture-secret");
			return userId === null ? null : { userId: asUserId(userId) };
		},
	};
}
function membershipsOf(
	entries: Record<string, ActiveMembership[]>,
	throws = false,
): MembershipReader {
	return {
		async getActiveMembership(userId, requestedOrganizationId) {
			if (throws) throw new Error("private membership fixture-secret");
			const list = entries[userId] ?? [];
			return requestedOrganizationId === undefined
				? list
				: list.filter(
						(entry) => entry.organizationId === requestedOrganizationId,
					);
		},
	};
}
const membershipA: ActiveMembership = {
	organizationId: orgA,
	role: "member",
};
const membershipB: ActiveMembership = {
	organizationId: orgB,
	role: "admin",
};

describe("trusted caller scope", () => {
	const cases: Array<{
		name: string;
		session: SessionResolver;
		memberships: MembershipReader;
		code: "AUTH_REQUIRED" | "FORBIDDEN";
	}> = [
		{
			name: "no session",
			session: sessionOf(null),
			memberships: membershipsOf({ [userA]: [membershipA] }),
			code: "AUTH_REQUIRED",
		},
		{
			name: "session resolver throws",
			session: sessionOf(userA, true),
			memberships: membershipsOf({ [userA]: [membershipA] }),
			code: "AUTH_REQUIRED",
		},
		{
			name: "malformed session user",
			session: sessionOf("not-a-uuid"),
			memberships: membershipsOf({ "not-a-uuid": [membershipA] }),
			code: "AUTH_REQUIRED",
		},
		{
			name: "no active membership",
			session: sessionOf(userA),
			memberships: membershipsOf({}),
			code: "FORBIDDEN",
		},
		{
			name: "membership reader throws",
			session: sessionOf(userA),
			memberships: membershipsOf({ [userA]: [membershipA] }, true),
			code: "FORBIDDEN",
		},
		{
			name: "malformed membership organization",
			session: sessionOf(userA),
			memberships: membershipsOf({
				[userA]: [
					{
						organizationId: asOrganizationId("not-a-uuid"),
						role: "owner",
					},
				],
			}),
			code: "FORBIDDEN",
		},
		{
			name: "unknown membership role",
			session: sessionOf(userA),
			memberships: membershipsOf({
				[userA]: [
					{
						organizationId: orgA,
						role: "superuser" as unknown as ActiveMembership["role"],
					},
				],
			}),
			code: "FORBIDDEN",
		},
	];
	for (const entry of cases)
		test(`denies ${entry.name}`, async () => {
			expect(
				resolveCallerScope({
					session: entry.session,
					memberships: entry.memberships,
				}),
			).rejects.toMatchObject({ code: entry.code });
		});

	test("resolves the active organization and user", async () => {
		expect(
			await resolveCallerScope({
				session: sessionOf(userA),
				memberships: membershipsOf({ [userA]: [membershipA, membershipB] }),
				requestedOrganizationId: orgB,
			}),
		).toEqual({ organizationId: orgB, userId: userA, role: "admin" });
	});
	test("deterministic organization when no organization was requested", async () => {
		expect(
			await resolveCallerScope({
				session: sessionOf(userA),
				memberships: membershipsOf({
					[userA]: [membershipB, membershipA],
				}),
			}),
		).toEqual({ organizationId: orgA, userId: userA, role: "member" });
	});
	test("requested organization mismatch is FORBIDDEN", async () => {
		expect(
			resolveCallerScope({
				session: sessionOf(userA),
				memberships: membershipsOf({ [userA]: [membershipA] }),
				requestedOrganizationId: orgB,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	test("malformed requested organization is FORBIDDEN", async () => {
		expect(
			resolveCallerScope({
				session: sessionOf(userA),
				memberships: membershipsOf({ [userA]: [membershipA] }),
				requestedOrganizationId: asOrganizationId("not-a-uuid"),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("test/development demo adapter", () => {
	const denied: RuntimeConfig[] = [
		{},
		{ nodeEnv: "production", localDemo: "true" },
		{ nodeEnv: "staging", localDemo: "true" },
		{ nodeEnv: "development" },
		{ nodeEnv: "test", localDemo: "false" },
		{
			nodeEnv: "test",
			localDemo: "true",
			databaseUrl: "postgres://unused-fixture",
		},
	];
	for (const config of denied)
		test(`refuses ${JSON.stringify(config)}`, () => {
			expect(() => createLocalDemoAdapters(config)).toThrow();
			try {
				createLocalDemoAdapters(config);
			} catch (error) {
				expect(error).toMatchObject({ code: "AUTH_REQUIRED" });
			}
		});
	for (const nodeEnv of ["development", "test"])
		test(`resolves demo scope in ${nodeEnv}`, async () => {
			expect(
				await resolveCallerScope(
					createLocalDemoAdapters({ nodeEnv, localDemo: "true" }),
				),
			).toEqual({
				organizationId: demoScope.organizationId,
				userId: demoScope.userId,
				role: "owner",
			});
		});
	test("demo adapter refuses another organization", async () => {
		expect(
			resolveCallerScope({
				...createLocalDemoAdapters({ nodeEnv: "test", localDemo: "true" }),
				requestedOrganizationId: otherScope.organizationId,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("tenant isolation at the service boundary", () => {
	function callerService(
		h: ReturnType<typeof harness>,
		session: SessionResolver,
		memberships: MembershipReader,
		requestedOrganizationId?: Parameters<
			typeof resolveCallerScope
		>[0]["requestedOrganizationId"],
	) {
		let reads = 0;
		const service = createTaskService({
			resolveScope: () =>
				resolveCallerScope({
					session,
					memberships,
					requestedOrganizationId,
				}),
			getStore: async () => {
				reads++;
				return h.store;
			},
		});
		return { service, reads: () => reads };
	}
	test("caller from org A cannot submit or list org B data", async () => {
		const h = harness();
		h.ownRepository(repoA, orgA);
		h.ownRepository(repoB, orgB);
		const a = callerService(
			h,
			sessionOf(userA),
			membershipsOf({ [userA]: [membershipA] }),
		);
		const b = callerService(
			h,
			sessionOf(userB),
			membershipsOf({ [userB]: [membershipB] }),
		);
		// Harness ownership is keyed by organization; borrow the demo ids so the
		// seeded fixture stays consistent for the cross-tenant write.
		h.ownRepository(localDemo.repositoryId, orgA);
		const submitted = await a.service.submit(input());
		if (!submitted.ok) throw new Error("Expected org A task");
		expect(await b.service.submit(input())).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(await b.service.list({})).toEqual({ ok: true, value: [] });
		const listed = await a.service.list({});
		if (!listed.ok) throw new Error("Expected org A list");
		expect(listed.value.map((task) => task.id)).toEqual([
			submitted.value.task.id,
		]);
	});
	test("requested foreign organization is denied before storage", async () => {
		const h = harness();
		const caller = callerService(
			h,
			sessionOf(userA),
			membershipsOf({ [userA]: [membershipA] }),
			orgB,
		);
		expect(await caller.service.list({})).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(caller.reads()).toBe(0);
	});
	test("missing session is AUTH_REQUIRED before storage", async () => {
		const h = harness();
		const caller = callerService(
			h,
			sessionOf(null),
			membershipsOf({ [userA]: [membershipA] }),
		);
		expect(await caller.service.submit(input())).toMatchObject({
			ok: false,
			error: { code: "AUTH_REQUIRED" },
		});
		expect(caller.reads()).toBe(0);
	});
});
