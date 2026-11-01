import { describe, expect, test } from "bun:test";
import {
	canManageMembers,
	EXECUTION_POLICY,
	isSettingsRole,
	settingsRoleLabel,
} from "./contracts";

describe("settings contracts", () => {
	test("labels every membership role", () => {
		expect(settingsRoleLabel("owner")).toBe("Owner");
		expect(settingsRoleLabel("admin")).toBe("Admin");
		expect(settingsRoleLabel("member")).toBe("Member");
		expect(settingsRoleLabel("viewer")).toBe("Viewer");
	});

	test("only owners and admins hold the member capability", () => {
		expect(canManageMembers("owner")).toBe(true);
		expect(canManageMembers("admin")).toBe(true);
		expect(canManageMembers("member")).toBe(false);
		expect(canManageMembers("viewer")).toBe(false);
	});

	test("rejects values that are not membership roles", () => {
		expect(isSettingsRole("owner")).toBe(true);
		expect(isSettingsRole("Owner")).toBe(false);
		expect(isSettingsRole("")).toBe(false);
		expect(isSettingsRole(null)).toBe(false);
	});

	test("execution policy states the shipped rules as read-only facts", () => {
		const ids = EXECUTION_POLICY.map((rule) => rule.id);
		expect(ids).toEqual([
			"sandbox-isolation",
			"risk-bands",
			"approval-gated-writes",
			"connector-cap",
			"device-credentials",
		]);
		for (const rule of EXECUTION_POLICY) {
			expect(rule.title.length).toBeGreaterThan(0);
			expect(rule.detail.length).toBeGreaterThan(0);
		}
		const text = EXECUTION_POLICY.map((rule) => rule.detail).join(" ");
		expect(text).toContain("read_only");
		expect(text).toContain("scoped_write");
		expect(text).toContain("sensitive");
		expect(text).toContain("destructive");
		expect(text).toContain("Ten connectors");
		expect(text).toContain("keychain");
	});
});
