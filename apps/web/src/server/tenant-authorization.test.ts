import { describe, expect, test } from "bun:test";
import { createInMemoryTenancy } from "@isolate/db/testing";
import { asOrganizationId, asUserId } from "@isolate/shared";
import type { NeonAuthServer } from "@neondatabase/auth/server";
import { createAuthService } from "./auth-service.server";
import {
	type ActiveMembership,
	resolveCallerScope,
	type SessionResolver,
} from "./caller-scope.server";
import { harness, input, scope } from "./test-fixtures";

const orgA = asOrganizationId("50000000-0000-4000-8000-000000000001");
const orgB = asOrganizationId("50000000-0000-4000-8000-000000000002");
const userA = asUserId("50000000-0000-4000-8000-000000000003");
const userB = asUserId("50000000-0000-4000-8000-000000000004");

function sessionOf(userId: string | null): SessionResolver {
	return {
		async getSession() {
			return userId === null ? null : { userId: asUserId(userId) };
		},
	};
}
function membershipsOf(entries: Record<string, ActiveMembership[]>): {
	getActiveMembership(
		userId: string,
		requestedOrganizationId?: string,
	): Promise<ActiveMembership[] | null>;
} {
	return {
		async getActiveMembership(userId, requestedOrganizationId) {
			const list = entries[userId] ?? [];
			if (requestedOrganizationId === undefined) return list;
			return (
				list.filter(
					(entry) => entry.organizationId === requestedOrganizationId,
				) ?? null
			);
		},
	};
}

describe("role-based tenant authorization", () => {
	const roles = ["owner", "admin", "member", "viewer"] as const;
	for (const role of roles) {
		const caller = { ...scope, role };
		test(`${role} may list the organization's tasks`, async () => {
			const h = harness();
			const service = h.serviceFor(caller);
			expect((await service.list({})).ok).toBe(true);
		});
	}
	test("a viewer may read but never submit", async () => {
		const h = harness();
		const viewer = h.serviceFor({ ...scope, role: "viewer" });
		expect(await viewer.submit(input())).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(h.tasks.calls).toHaveLength(0);
		expect(h.queue.calls).toHaveLength(0);
		expect(h.compilation.calls).toHaveLength(0);
		expect((await viewer.list({})).ok).toBe(true);
	});
	for (const role of ["owner", "admin", "member"] as const)
		test(`a ${role} may submit a task`, async () => {
			const h = harness();
			const result = await h.serviceFor({ ...scope, role }).submit(input());
			expect(result.ok).toBe(true);
			expect(h.tasks.calls).toHaveLength(1);
			expect(h.queue.calls).toHaveLength(1);
		});
	test("an unknown role is not a trusted scope", async () => {
		const h = harness();
		const service = h.serviceFor({
			...scope,
			role: "superuser" as unknown as (typeof scope)["role"],
		});
		expect(await service.submit(input())).toMatchObject({
			ok: false,
			error: { code: "AUTH_REQUIRED" },
		});
		expect(h.tasks.calls).toHaveLength(0);
	});
	test("the role never widens the organization boundary", async () => {
		const h = harness();
		// The repository belongs to the demo organization only.
		h.ownRepository(input().repositoryId, scope.organizationId);
		const other = h.serviceFor({
			organizationId: orgB,
			userId: userB,
			role: "owner",
		});
		expect(await other.submit(input())).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(h.tasks.calls).toHaveLength(0);
	});
});

describe("membership resolution and the remembered organization", () => {
	const memberships = membershipsOf({
		[userA]: [
			{ organizationId: orgA, role: "member" },
			{ organizationId: orgB, role: "admin" },
		],
	});
	test("the role comes from the membership row", async () => {
		expect(
			await resolveCallerScope({
				session: sessionOf(userA),
				memberships,
				requestedOrganizationId: orgB,
			}),
		).toEqual({ organizationId: orgB, userId: userA, role: "admin" });
	});
	test("a remembered organization the caller left is ignored", async () => {
		const left = asOrganizationId("50000000-0000-4000-8000-000000000099");
		expect(
			await resolveCallerScope({
				session: sessionOf(userA),
				memberships,
				preferredOrganizationId: left,
			}),
		).toEqual({ organizationId: orgA, userId: userA, role: "member" });
	});
	test("a remembered organization the caller still holds is honoured", async () => {
		expect(
			await resolveCallerScope({
				session: sessionOf(userA),
				memberships,
				preferredOrganizationId: orgB,
			}),
		).toEqual({ organizationId: orgB, userId: userA, role: "admin" });
	});
	test("a requested organization the caller does not hold is FORBIDDEN", async () => {
		expect(
			resolveCallerScope({
				session: sessionOf(userA),
				memberships,
				requestedOrganizationId: asOrganizationId(
					"50000000-0000-4000-8000-000000000098",
				),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("auth service tenancy", () => {
	function authHarness() {
		const tenancy = createInMemoryTenancy();
		let stored: string | undefined;
		let sessionUser: { id: string; email: string; name: string } | null = null;
		const server = {
			async getSession() {
				return sessionUser
					? { data: { session: {}, user: sessionUser }, error: null }
					: { data: null, error: null };
			},
			async signIn() {
				return { data: {}, error: null };
			},
			async signUp() {
				return { data: {}, error: null };
			},
			async signOut() {
				return { data: {}, error: null };
			},
		} as unknown as NeonAuthServer;
		const service = createAuthService({
			server,
			memberships: tenancy.memberships,
			organizations: tenancy.organizations,
			ensureTenancy: async () => {},
			readActiveOrganization: () => stored as never,
			writeActiveOrganization: (id) => {
				stored = id;
			},
			requestOrigin: () => "http://localhost:3000",
		});
		return {
			tenancy,
			service,
			signInAs: (user: { id: string; email: string; name: string }) => {
				sessionUser = user;
			},
			stored: () => stored,
		};
	}
	test("the session lists only the caller's organizations", async () => {
		const h = authHarness();
		await h.tenancy.organizations.createWithOwner({
			id: orgA,
			name: "Alpha",
			slug: "alpha",
			ownerId: userA,
		});
		await h.tenancy.organizations.createWithOwner({
			id: orgB,
			name: "Beta",
			slug: "beta",
			ownerId: userB,
		});
		await h.tenancy.memberships.add({
			organizationId: orgB,
			userId: userA,
			role: "viewer",
		});
		h.signInAs({ id: userA, email: "a@example.test", name: "A" });
		const session = await h.service.currentSession();
		expect(session.user?.id).toBe(userA);
		expect(session.organizations.map((entry) => entry.id).sort()).toEqual(
			[orgA, orgB].sort(),
		);
		expect(session.organizations.find((entry) => entry.id === orgB)?.role).toBe(
			"viewer",
		);
	});
	test("selecting a foreign organization is FORBIDDEN", async () => {
		const h = authHarness();
		await h.tenancy.organizations.createWithOwner({
			id: orgA,
			name: "Alpha",
			slug: "alpha",
			ownerId: userA,
		});
		await h.tenancy.organizations.createWithOwner({
			id: orgB,
			name: "Beta",
			slug: "beta",
			ownerId: userB,
		});
		h.signInAs({ id: userA, email: "a@example.test", name: "A" });
		expect(
			await h.service.selectOrganization({ organizationId: orgB }),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(h.stored()).toBeUndefined();
	});
	test("selecting a member organization records the preference", async () => {
		const h = authHarness();
		await h.tenancy.organizations.createWithOwner({
			id: orgA,
			name: "Alpha",
			slug: "alpha",
			ownerId: userA,
		});
		h.signInAs({ id: userA, email: "a@example.test", name: "A" });
		expect(
			await h.service.selectOrganization({ organizationId: orgA }),
		).toEqual({ ok: true });
		expect(h.stored()).toBe(orgA);
	});
	test("an anonymous caller cannot create an organization", async () => {
		const h = authHarness();
		expect(
			await h.service.createOrganization({ name: "Gamma", slug: "gamma" }),
		).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
	});
	test("creating an organization makes the caller its owner", async () => {
		const h = authHarness();
		h.signInAs({ id: userA, email: "a@example.test", name: "A" });
		const result = await h.service.createOrganization({
			name: "Gamma",
			slug: "gamma",
		});
		expect(result).toMatchObject({
			ok: true,
			organization: { name: "Gamma", slug: "gamma", role: "owner" },
		});
		if (!result.ok) throw new Error("Expected organization");
		expect(
			await h.tenancy.memberships.getForUser(
				userA,
				result.organization.id as never,
			),
		).toMatchObject({ role: "owner" });
	});
	test("a taken organization address is refused", async () => {
		const h = authHarness();
		h.signInAs({ id: userA, email: "a@example.test", name: "A" });
		await h.tenancy.organizations.createWithOwner({
			id: orgA,
			name: "Alpha",
			slug: "alpha",
			ownerId: userA,
		});
		expect(
			await h.service.createOrganization({
				name: "Alpha again",
				slug: "alpha",
			}),
		).toMatchObject({ ok: false, error: { code: "SLUG_TAKEN" } });
	});
	test("an invalid organization address never reaches storage", async () => {
		const h = authHarness();
		h.signInAs({ id: userA, email: "a@example.test", name: "A" });
		expect(
			await h.service.createOrganization({ name: "Gamma", slug: "Not A Slug" }),
		).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
	});
});
