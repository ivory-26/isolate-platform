export const navLinks = [
	{ href: "#capabilities", label: "Capabilities" },
	{ href: "#lifecycle", label: "Lifecycle" },
	{ href: "#trust", label: "Trust boundary" },
] as const;

export const facts = [
	{ label: "Execution", value: "Isolated sandbox" },
	{ label: "Approval", value: "Payload-bound" },
	{ label: "Credentials", value: "Device-held" },
	{ label: "Connectors", value: "Ten supported" },
] as const;

export const lifecycle = [
	{
		title: "Queue",
		event: "task.submitted",
		copy: "Pin a workflow version and submit one bounded task.",
	},
	{
		title: "Execute",
		event: "sandbox.provisioned",
		copy: "A worker claims the job and provisions an isolated sandbox.",
	},
	{
		title: "Validate",
		event: "validation.finished",
		copy: "The diff gate and the repository’s validation command decide.",
	},
	{
		title: "Approve",
		event: "approval.decided",
		copy: "A person authorizes the exact push or pull request.",
	},
] as const;

export const runEvents = [
	{
		event: "task.submitted",
		offset: "+0.0s",
		detail: "worker · review_ready · 2 files",
	},
	{
		event: "sandbox.provisioned",
		offset: "+1.2s",
		detail: "worker · egress denied",
	},
	{
		event: "validation.finished",
		offset: "+42.6s",
		detail: "worker · exit 0 · 214 checks",
	},
	{
		event: "approval.requested",
		offset: "+43.1s",
		detail: "worker · push · payload 9f3c…",
	},
	{
		event: "approval.decided",
		offset: "+2m 14s",
		detail: "maya.chen · approved · audited",
	},
] as const;
