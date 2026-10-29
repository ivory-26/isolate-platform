import { describe, expect, test } from "bun:test";
import {
	type ArgumentRule,
	type CommandPolicy,
	type CommandRequest,
	commandPolicy,
	type EgressPolicy,
	validateArgs,
	validateEgress,
	validateOutputLimit,
	validateTimeout,
} from "./command-policy";
import { validateSandboxPath } from "./paths";

const policy: CommandPolicy = {
	workspaceRoot: "/workspace",
	allowlist: [
		{
			executable: "bun",
			args: [
				{ kind: "literal", value: "test" },
				{ kind: "oneOf", values: ["unit", "integration"] },
			],
		},
	],
	maxTimeoutMs: 5000,
	maxOutputBytes: 4096,
	egress: { mode: "deny" },
};
const request: CommandRequest = {
	executable: "bun",
	args: ["test", "unit"],
	cwd: "/workspace/repo",
	timeoutMs: 1000,
	maxOutputBytes: 512,
};

function denied(fn: () => unknown): void {
	expect(fn).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
}

describe("explicit command allowlist", () => {
	test("empty allowlist denies; explicit exact argv succeeds with immutable deny-egress snapshot", () => {
		denied(() => commandPolicy({ ...policy, allowlist: [] }, request));
		const args = ["test", "unit"];
		const command = commandPolicy(policy, { ...request, args });
		args[0] = "run";
		expect(command.args).toEqual(["test", "unit"]);
		expect(command.egress).toEqual({ mode: "deny" });
		expect(Object.isFrozen(command)).toBe(true);
		expect(Object.isFrozen(command.args)).toBe(true);
		expect(Object.isFrozen(command.egress)).toBe(true);
	});

	test.each([
		"sh",
		"bash",
		"git",
		"./bun",
		"/bin/bun",
		"bun.exe",
		"bun;sh",
		"BUN",
	])("denies unknown executable %s", (executable) => {
		denied(() => commandPolicy(policy, { ...request, executable }));
	});

	test.each(
		[
			[],
			["test"],
			["test", "unit", "--watch"],
			["run", "unit"],
			["test", "--eval=bad"],
			["test", "unit;bad"],
			["test", "unit\n"],
			["test", "unit\0"],
			["test", "a".repeat(4097)],
		].map((args) => [args] as const),
	)("denies wrong argv %#", (args) => {
		denied(() => commandPolicy(policy, { ...request, args }));
	});

	test("multiple allowlist shapes are alternatives, never prefixes", () => {
		const expanded: CommandPolicy = {
			...policy,
			allowlist: [
				{ executable: "bun", args: [{ kind: "literal", value: "--version" }] },
				...policy.allowlist,
			],
		};
		expect(commandPolicy(expanded, request).args).toEqual(request.args);
		expect(
			commandPolicy(expanded, { ...request, args: ["--version"] }).args,
		).toEqual(["--version"]);
		denied(() =>
			commandPolicy(expanded, { ...request, args: ["--version", "--eval"] }),
		);
	});

	test("patterns are full matches, have bounded length, and do not inherit regex state", () => {
		const rule: ArgumentRule[] = [
			{ kind: "pattern", pattern: /[a-z]+/g, maxLength: 5 },
		];
		validateArgs(["unit"], rule);
		validateArgs(["unit"], rule);
		for (const arg of [
			"--unit",
			"a;b",
			"a|b",
			"a`b",
			"a<b",
			"a>b",
			`a${String.fromCharCode(92)}b`,
			`a${String.fromCharCode(36)}b`,
		]) {
			denied(() =>
				validateArgs(
					[arg],
					[{ kind: "pattern", pattern: /.+/, maxLength: 64 }],
				),
			);
		}
		denied(() => validateArgs(["1unit"], rule));
		denied(() => validateArgs(["unit1"], rule));
		denied(() => validateArgs(["longer"], rule));
	});
});

describe("resource budgets", () => {
	test.each([
		0,
		-1,
		0.5,
		NaN,
		Infinity,
		5001,
		Number.MAX_SAFE_INTEGER,
	])("denies timeout %s", (value) => {
		denied(() => validateTimeout(value, 5000));
		denied(() => commandPolicy(policy, { ...request, timeoutMs: value }));
	});
	test.each([
		0,
		-1,
		0.5,
		NaN,
		Infinity,
		4097,
	])("denies output budget %s", (value) => {
		denied(() => validateOutputLimit(value, 4096));
		denied(() => commandPolicy(policy, { ...request, maxOutputBytes: value }));
	});
	test("inclusive boundaries and hard caps", () => {
		expect(validateTimeout(1, 300000)).toBe(1);
		expect(validateTimeout(300000, 300000)).toBe(300000);
		expect(validateOutputLimit(1048576, 1048576)).toBe(1048576);
		for (const max of [0, -1, NaN, Infinity, 300001])
			denied(() => validateTimeout(1, max));
		denied(() => validateOutputLimit(1, 1048577));
	});
});

describe("sandbox paths", () => {
	test.each([
		"repo",
		"-repo",
		"/",
		"/other/repo",
		"/workspace-other/repo",
		"/workspace/../other",
		"/workspace/./repo",
		"/workspace//repo",
		"/workspace/repo/",
		"/workspace/-C",
		"C:/repo",
		"//server/share",
		"/workspace/repo" +
			String.fromCharCode(92) +
			".." +
			String.fromCharCode(92) +
			"other",
		"/workspace/repo\n",
		"/workspace/repo\0",
		"/workspace/%2e%2e",
		"/workspace/a;echo",
		"/workspace/a.",
	])("denies path injection %j", (path) => {
		denied(() => validateSandboxPath("/workspace", path));
		denied(() => commandPolicy(policy, { ...request, cwd: path }));
	});
	test("canonical paths allow spaces without shell parsing", () => {
		expect(
			validateSandboxPath("/workspace", "/workspace/repo with spaces"),
		).toBe("/workspace/repo with spaces");
	});
});

describe("egress intent", () => {
	const allowed: EgressPolicy = {
		mode: "allowlist",
		hosts: ["registry.npmjs.org", "github.com"],
	};
	test("deny is default even when the ceiling permits network", () => {
		expect(
			commandPolicy({ ...policy, egress: allowed }, request).egress,
		).toEqual({ mode: "deny" });
		denied(() => commandPolicy(policy, { ...request, egress: allowed }));
	});
	test("only exact host subsets; snapshot cannot be widened afterwards", () => {
		const hosts = ["github.com"];
		const checked = validateEgress({ mode: "allowlist", hosts }, allowed);
		hosts.push("attacker.com");
		expect(checked).toEqual({ mode: "allowlist", hosts: ["github.com"] });
		if (checked.mode === "allowlist")
			expect(Object.isFrozen(checked.hosts)).toBe(true);
		denied(() =>
			validateEgress({ mode: "allowlist", hosts: ["api.github.com"] }, allowed),
		);
	});
	test.each([
		"*",
		"*.github.com",
		"https://github.com",
		"github.com:443",
		"github.com/evil",
		"user@github.com",
		"github.com.",
		"GITHUB.COM",
		"127.0.0.1",
		"169.254.169.254",
		"[::1]",
		"localhost",
		"svc.local",
		"db.internal",
	])("denies malformed/private egress %s", (host) => {
		const network: EgressPolicy = { mode: "allowlist", hosts: [host] };
		denied(() => validateEgress(network, network));
	});
	test("empty and unknown network modes fail closed", () => {
		denied(() => validateEgress({ mode: "allowlist", hosts: [] }, allowed));
		denied(() =>
			validateEgress({ mode: "all" } as unknown as EgressPolicy, allowed),
		);
	});
});
