import { describe, expect, test } from "bun:test";
import type { AuthState } from "./contracts";
import { resolveSessionState } from "./session-state";

const session = {
	user: { id: "user-1", email: "owner@example.com", name: "Owner" },
	organizations: [
		{
			id: "10000000-0000-4000-8000-000000000001",
			name: "Workspace",
			slug: "workspace",
			role: "owner" as const,
		},
	],
	activeOrganizationId: "10000000-0000-4000-8000-000000000001",
};

const authenticated: AuthState = { mode: "authenticated", session };

describe("resolveSessionState", () => {
	test("prefers the cached posture once the query has data", () => {
		expect(resolveSessionState(authenticated, { mode: "anonymous" })).toBe(
			authenticated,
		);
	});

	test("uses the loader posture before the cache holds a value", () => {
		expect(resolveSessionState(undefined, authenticated)).toBe(authenticated);
	});

	test("never invents an authenticated posture without evidence", () => {
		expect(resolveSessionState(undefined, undefined)).toEqual({
			mode: "anonymous",
		});
	});

	test("does not let a stale loader value override a demo cache", () => {
		expect(resolveSessionState({ mode: "demo" }, authenticated)).toEqual({
			mode: "demo",
		});
	});
});
