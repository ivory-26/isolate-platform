import { describe, expect, test } from "bun:test";
import { asOrganizationId, asUserId } from "@isolate/shared";
import { hasCapability } from "../roles";
import {
	createInMemoryTenancy,
	InMemoryMembershipRepository,
	InMemoryOrganizationRepository,
	InMemoryUserRepository,
} from "../testing/access-fakes";

const owner = asUserId("50000000-0000-4000-8000-000000000001");
const other = asUserId("50000000-0000-4000-8000-000000000002");
const orgA = asOrganizationId("50000000-0000-4000-8000-000000000003");
const orgB = asOrganizationId("50000000-0000-4000-8000-000000000004");

describe("user repository", () => {
	test("creates then updates the same identity", async () => {
		const users = new InMemoryUserRepository();
		const created = await users.ensure({
			id: owner,
			email: "owner@example.test",
			displayName: "Owner",
		});
		expect(created.created_at).toBeInstanceOf(Date);
		const updated = await users.ensure({
			id: owner,
			email: "owner@example.test",
			displayName: "Renamed",
		});
		expect(updated.display_name).toBe("Renamed");
		expect(updated.created_at).toEqual(created.created_at);
		expect(await users.getById(owner)).toMatchObject({
			id: owner,
			email: "owner@example.test",
		});
	});
	test("two identities cannot claim one email address", async () => {
		const users = new InMemoryUserRepository();
		await users.ensure({
			id: owner,
			email: "shared@example.test",
			displayName: "Owner",
		});
		expect(
			users.ensure({
				id: other,
				email: "shared@example.test",
				displayName: "Other",
			}),
		).rejects.toThrow("users_email_key");
	});
	test("blank fields are rejected", async () => {
		const users = new InMemoryUserRepository();
		expect(
			users.ensure({ id: owner, email: "", displayName: "Owner" }),
		).rejects.toThrow();
	});
});

describe("membership repository", () => {
	test("memberships are unique per organization and user", async () => {
		const memberships = new InMemoryMembershipRepository();
		await memberships.add({
			organizationId: orgA,
			userId: owner,
			role: "member",
		});
		const upgraded = await memberships.add({
			organizationId: orgA,
			userId: owner,
			role: "admin",
		});
		expect(upgraded.role).toBe("admin");
		expect(await memberships.countForUser(owner)).toBe(1);
	});
	test("an unknown role is rejected", async () => {
		const memberships = new InMemoryMembershipRepository();
		expect(
			memberships.add({
				organizationId: orgA,
				userId: owner,
				role: "root" as never,
			}),
		).rejects.toThrow("unknown membership role");
	});
	test("memberships are listed per user, never across users", async () => {
		const memberships = new InMemoryMembershipRepository();
		await memberships.add({
			organizationId: orgA,
			userId: owner,
			role: "owner",
		});
		await memberships.add({
			organizationId: orgB,
			userId: other,
			role: "owner",
		});
		expect(await memberships.listForUser(owner)).toHaveLength(1);
		expect(await memberships.listForUser(other)).toHaveLength(1);
		expect(await memberships.getForUser(owner, orgB)).toBeNull();
	});
	test("removal reports whether a row existed", async () => {
		const memberships = new InMemoryMembershipRepository();
		await memberships.add({
			organizationId: orgA,
			userId: owner,
			role: "owner",
		});
		expect(
			await memberships.remove({ organizationId: orgA, userId: owner }),
		).toBe(true);
		expect(
			await memberships.remove({ organizationId: orgA, userId: owner }),
		).toBe(false);
	});
});

describe("organization repository", () => {
	test("creating an organization grants the owner membership", async () => {
		const { memberships, organizations } = createInMemoryTenancy();
		await organizations.createWithOwner({
			id: orgA,
			name: "Acme",
			slug: "acme",
			ownerId: owner,
		});
		expect(await memberships.getForUser(owner, orgA)).toMatchObject({
			role: "owner",
		});
	});
	test("a personal workspace is created only for a user without memberships", async () => {
		const { memberships, organizations } = createInMemoryTenancy();
		const first = await organizations.createIfUnowned({
			id: orgA,
			name: "Acme",
			slug: "acme",
			ownerId: owner,
		});
		expect(first?.slug).toBe("acme");
		const second = await organizations.createIfUnowned({
			id: orgB,
			name: "Acme Two",
			slug: "acme-two",
			ownerId: owner,
		});
		expect(second).toBeNull();
		expect(await memberships.countForUser(owner)).toBe(1);
	});
	test("a second user still gets a personal workspace", async () => {
		const { organizations } = createInMemoryTenancy();
		await organizations.createIfUnowned({
			id: orgA,
			name: "Acme",
			slug: "acme",
			ownerId: owner,
		});
		expect(
			await organizations.createIfUnowned({
				id: orgB,
				name: "Other",
				slug: "other",
				ownerId: other,
			}),
		).not.toBeNull();
	});
	test("slugs are unique", async () => {
		const { organizations } = createInMemoryTenancy();
		await organizations.createWithOwner({
			id: orgA,
			name: "Acme",
			slug: "acme",
			ownerId: owner,
		});
		expect(
			organizations.createWithOwner({
				id: orgB,
				name: "Acme",
				slug: "acme",
				ownerId: other,
			}),
		).rejects.toThrow("organizations_slug_key");
	});
	test("organizations are readable by id and slug", async () => {
		const { organizations } = createInMemoryTenancy();
		await organizations.createWithOwner({
			id: orgA,
			name: "Acme",
			slug: "acme",
			ownerId: owner,
		});
		expect((await organizations.getById(orgA))?.name).toBe("Acme");
		expect((await organizations.getBySlug("acme"))?.id).toBe(orgA);
		expect(await organizations.getBySlug("missing")).toBeNull();
	});
	test("an organization without a membership source creates no owner row", async () => {
		const organizations = new InMemoryOrganizationRepository();
		await organizations.createWithOwner({
			id: orgA,
			name: "Acme",
			slug: "acme",
			ownerId: owner,
		});
		expect(await organizations.getById(orgA)).not.toBeNull();
	});
});

describe("role capabilities", () => {
	test("viewers may read but never submit", () => {
		expect(hasCapability("viewer", "task:read")).toBe(true);
		expect(hasCapability("viewer", "task:submit")).toBe(false);
		expect(hasCapability("viewer", "member:manage")).toBe(false);
	});
	test("members may submit but never manage members", () => {
		expect(hasCapability("member", "task:submit")).toBe(true);
		expect(hasCapability("member", "member:manage")).toBe(false);
	});
	test("admins and owners manage members", () => {
		expect(hasCapability("admin", "member:manage")).toBe(true);
		expect(hasCapability("owner", "member:manage")).toBe(true);
	});
});
