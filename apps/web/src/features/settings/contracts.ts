/**
 * Client-safe contracts for the workspace settings read models (W20).
 *
 * These shapes carry organization metadata only: no user ids, no tokens and no
 * credentials. The server projects them from the tenant-scoped
 * `organizations`, `memberships` and `users` tables.
 */

export const SETTINGS_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type SettingsRole = (typeof SETTINGS_ROLES)[number];

export type WorkspaceSummary = {
	readonly name: string;
	readonly slug: string;
	/** The caller's role in this organization, from the membership row. */
	readonly role: SettingsRole;
	readonly memberCount: number;
};

export type WorkspaceMember = {
	readonly email: string;
	readonly displayName: string;
	readonly role: SettingsRole;
};

export type SettingsReadResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: { readonly message: string } };

const ROLE_LABELS: Record<SettingsRole, string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
	viewer: "Viewer",
};

export function settingsRoleLabel(role: SettingsRole): string {
	return ROLE_LABELS[role];
}

/** Membership changes are not implemented; only owners and admins could ever manage them. */
export function canManageMembers(role: SettingsRole): boolean {
	return role === "owner" || role === "admin";
}

export function isSettingsRole(value: unknown): value is SettingsRole {
	return (
		typeof value === "string" &&
		(SETTINGS_ROLES as readonly string[]).includes(value)
	);
}

export type ExecutionPolicyRule = {
	readonly id: string;
	readonly title: string;
	readonly detail: string;
};

/**
 * The enforced execution policy, read-only.
 *
 * Each statement is backed by the shipped product: sandbox isolation, the tool
 * risk table, payload-bound approvals for branch push / PR creation, the
 * ten-connector cap and the device-held credential model. The settings page
 * renders these as facts, never as editable toggles.
 */
export const EXECUTION_POLICY: readonly ExecutionPolicyRule[] = [
	{
		id: "sandbox-isolation",
		title: "Sandbox isolation",
		detail:
			"Every task runs in a disposable, isolated sandbox. The control plane and your browser never execute task code.",
	},
	{
		id: "risk-bands",
		title: "Tool risk bands",
		detail:
			"Tool calls are classified read_only, scoped_write, sensitive or destructive. read_only and scoped_write execute with an audit record, sensitive requires a human approval, and destructive is denied.",
	},
	{
		id: "approval-gated-writes",
		title: "Approval-gated branch push and pull request",
		detail:
			"Pushing a branch and opening a pull request are sensitive actions. They run only after an approval bound to the exact payload; a changed payload invalidates the approval.",
	},
	{
		id: "connector-cap",
		title: "Ten-connector cap",
		detail:
			"Ten connectors are supported: GitHub plus nine device-held adapters. There is no open-ended connector registry.",
	},
	{
		id: "device-credentials",
		title: "Device-held credentials",
		detail:
			"Vendor credentials stay in the operating-system keychain on your device. Isolate stores only a hashed device token and connector metadata, never a vendor key.",
	},
] as const;
