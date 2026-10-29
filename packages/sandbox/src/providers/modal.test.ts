import { describe, expect, spyOn, test } from "bun:test";
import { executeCommand } from "../execute";
import {
	type AuthorizedCommand,
	type CommandPolicy,
	commandPolicy,
} from "../policy/command-policy";
import type {
	ModalCreateParams,
	ModalExecParams,
	ModalExecResult,
	ModalSandboxClient,
} from "./modal";
import { ModalSandboxProvider } from "./modal";
import type { SandboxSpec } from "./types";

const spec: SandboxSpec = {
	workspaceRoot: "/workspace",
	lifetimeMs: 600_000,
	memoryMb: 1024,
	cpuCount: 2,
	egress: { mode: "deny" },
};

const policy: CommandPolicy = {
	workspaceRoot: "/workspace",
	allowlist: [
		{ executable: "git", args: [{ kind: "literal", value: "--version" }] },
	],
	maxTimeoutMs: 300_000,
	maxOutputBytes: 64,
	egress: { mode: "deny" },
};

const request = {
	executable: "git",
	args: ["--version"],
	cwd: "/workspace/repo",
	timeoutMs: 5_000,
	maxOutputBytes: 64,
};

function authorized(
	overrides: Partial<typeof request> = {},
	policyOverrides: Partial<CommandPolicy> = {},
): AuthorizedCommand {
	const activePolicy = { ...policy, ...policyOverrides };
	return commandPolicy(activePolicy, { ...request, ...overrides });
}

interface ExecCall {
	readonly id: string;
	readonly argv: readonly string[];
	readonly params: ModalExecParams;
}

interface FakeOptions {
	readonly create?: (params: ModalCreateParams) => Promise<{ id: string }>;
	readonly exec?: (
		id: string,
		argv: readonly string[],
		params: ModalExecParams,
	) => Promise<ModalExecResult>;
	readonly terminate?: (id: string) => Promise<void>;
}

function fakeClient(options: FakeOptions = {}) {
	const calls = {
		create: [] as ModalCreateParams[],
		exec: [] as ExecCall[],
		terminate: [] as string[],
	};
	const client: ModalSandboxClient = {
		create: async (params) => {
			calls.create.push(params);
			return options.create ? options.create(params) : { id: "sb-1" };
		},
		exec: async (id, argv, params) => {
			calls.exec.push({ id, argv, params });
			return options.exec
				? options.exec(id, argv, params)
				: { exitCode: 0, stdout: "", stderr: "", timedOut: false };
		},
		terminate: async (id) => {
			calls.terminate.push(id);
			if (options.terminate) await options.terminate(id);
		},
	};
	return { client, calls };
}

function clock(values: readonly number[]): () => number {
	let index = 0;
	return () => {
		const value = values[Math.min(index, values.length - 1)];
		index++;
		return value;
	};
}

const badSpecs: ReadonlyArray<readonly [string, Partial<SandboxSpec>]> = [
	["cpu below minimum", { cpuCount: 0.1 }],
	["cpu zero", { cpuCount: 0 }],
	["cpu above maximum", { cpuCount: 8.5 }],
	["cpu not finite", { cpuCount: Number.NaN }],
	["cpu infinite", { cpuCount: Number.POSITIVE_INFINITY }],
	["memory below minimum", { memoryMb: 127 }],
	["memory above maximum", { memoryMb: 16_385 }],
	["memory fractional", { memoryMb: 512.5 }],
	["lifetime below minimum", { lifetimeMs: 999 }],
	["lifetime above maximum", { lifetimeMs: 3_600_001 }],
	["lifetime fractional", { lifetimeMs: 1_500.5 }],
	["relative workspace", { workspaceRoot: "workspace" }],
	["host root", { workspaceRoot: "/" }],
	["windows host path", { workspaceRoot: "C:\\repo" }],
	["idle zero", { idleTimeoutMs: 0 }],
	["idle above lifetime", { idleTimeoutMs: 600_001 }],
	["empty allowlist", { egress: { mode: "allowlist", hosts: [] } }],
	[
		"localhost allowlist",
		{ egress: { mode: "allowlist", hosts: ["localhost"] } },
	],
	[
		"wildcard allowlist",
		{ egress: { mode: "allowlist", hosts: ["*.github.com"] } },
	],
	[
		"uppercase allowlist",
		{ egress: { mode: "allowlist", hosts: ["GitHub.com"] } },
	],
];

describe("ModalSandboxProvider.create", () => {
	test("maps a deny policy to exact Modal create parameters", async () => {
		const { client, calls } = fakeClient();
		const provider = new ModalSandboxProvider({ client });
		const handle = await provider.create(spec);
		expect(handle).toEqual({ id: "sb-1", workspaceRoot: "/workspace" });
		expect(calls.create).toHaveLength(1);
		const params = calls.create[0];
		expect(params).toEqual({
			cpu: 2,
			memoryMiB: 1024,
			timeoutMs: 600_000,
			idleTimeoutMs: 300_000,
			workdir: "/workspace",
			command: ["sleep", "48h"],
			blockNetwork: true,
		});
		expect(Object.hasOwn(params, "outboundDomainAllowlist")).toBe(false);
	});

	test("uses the spec idle timeout when present", async () => {
		const { client, calls } = fakeClient();
		const provider = new ModalSandboxProvider({ client });
		await provider.create({ ...spec, idleTimeoutMs: 60_000 });
		expect(calls.create[0].idleTimeoutMs).toBe(60_000);
	});

	test("maps an allowlist policy to outboundDomainAllowlist with network enabled", async () => {
		const { client, calls } = fakeClient();
		const provider = new ModalSandboxProvider({ client });
		await provider.create({
			...spec,
			egress: {
				mode: "allowlist",
				hosts: ["github.com", "registry.npmjs.org", "github.com"],
			},
		});
		expect(calls.create[0].blockNetwork).toBe(false);
		expect(calls.create[0].outboundDomainAllowlist).toEqual([
			"github.com",
			"registry.npmjs.org",
		]);
	});

	test.each(
		badSpecs,
	)("rejects %s before calling the provider", async (_label, overrides) => {
		const { client, calls } = fakeClient();
		const provider = new ModalSandboxProvider({ client });
		await expect(
			provider.create({ ...spec, ...overrides }),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		expect(calls.create).toHaveLength(0);
	});

	test("maps provisioning failures to PROVIDER_UNAVAILABLE without leaking details", async () => {
		const { client } = fakeClient({
			create: async () => {
				throw new Error("token secret says nope");
			},
		});
		const provider = new ModalSandboxProvider({ client });
		try {
			await provider.create(spec);
			throw new Error("expected create to reject");
		} catch (error) {
			expect(error).toMatchObject({
				code: "PROVIDER_UNAVAILABLE",
				message: "Modal sandbox provisioning failed",
			});
			expect((error as Error).message).not.toContain("nope");
		}
	});

	test.each([
		["empty id", ""],
		["non-string id", 42],
		["oversized id", "x".repeat(513)],
	] as const)("rejects a malformed provider handle (%s)", async (_label, id) => {
		const { client } = fakeClient({
			create: async () => ({ id }) as { id: string },
		});
		const provider = new ModalSandboxProvider({ client });
		await expect(provider.create(spec)).rejects.toMatchObject({
			code: "PROVIDER_PROTOCOL",
		});
	});
});

describe("ModalSandboxProvider.execute", () => {
	test("maps argv, cwd, timeout, streams, exit code, and duration", async () => {
		const { client, calls } = fakeClient({
			exec: async () => ({
				exitCode: 0,
				stdout: "hello",
				stderr: "warn",
				timedOut: false,
			}),
		});
		const provider = new ModalSandboxProvider({
			client,
			now: clock([1_000, 1_042]),
		});
		const command = authorized();
		const result = await provider.execute(
			{ id: "sb-1", workspaceRoot: "/workspace" },
			command,
		);
		expect(result).toEqual({
			exitCode: 0,
			stdout: "hello",
			stderr: "warn",
			durationMs: 42,
			timedOut: false,
			outputLimitExceeded: false,
		});
		expect(calls.exec).toHaveLength(1);
		expect(calls.exec[0]).toEqual({
			id: "sb-1",
			argv: ["git", "--version"],
			params: { timeoutMs: 5_000, workdir: "/workspace/repo" },
		});
	});

	test("maps a timed-out command to the conventional timeout exit code", async () => {
		const { client } = fakeClient({
			exec: async () => ({
				exitCode: 0,
				stdout: "partial",
				stderr: "",
				timedOut: true,
			}),
		});
		const provider = new ModalSandboxProvider({ client });
		const result = await provider.execute(
			{ id: "sb-1", workspaceRoot: "/workspace" },
			authorized(),
		);
		expect(result).toMatchObject({
			exitCode: 124,
			stdout: "partial",
			timedOut: true,
		});
	});

	test("caps combined output and reports truncation", async () => {
		const { client } = fakeClient({
			exec: async () => ({
				exitCode: 0,
				stdout: "a".repeat(50),
				stderr: "b".repeat(30),
				timedOut: false,
			}),
		});
		const provider = new ModalSandboxProvider({ client });
		const command = authorized({}, { maxOutputBytes: 64 });
		const result = await provider.execute(
			{ id: "sb-1", workspaceRoot: "/workspace" },
			command,
		);
		expect(result.outputLimitExceeded).toBe(true);
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBe(64);
		expect(result.stdout).toBe("a".repeat(50));
		expect(result.stderr).toBe("b".repeat(14));
	});

	test("never splits a multi-byte code point while capping", async () => {
		const { client } = fakeClient({
			exec: async () => ({
				exitCode: 0,
				stdout: "ééé",
				stderr: "xyz",
				timedOut: false,
			}),
		});
		const provider = new ModalSandboxProvider({ client });
		const command = authorized({ maxOutputBytes: 5 }, { maxOutputBytes: 5 });
		const result = await provider.execute(
			{ id: "sb-1", workspaceRoot: "/workspace" },
			command,
		);
		expect(result.outputLimitExceeded).toBe(true);
		expect(result.stdout).toBe("éé");
		expect(result.stderr).toBe("x");
		expect(
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
		).toBe(5);
	});

	test("rejects a pre-aborted signal without dispatching", async () => {
		const { client, calls } = fakeClient();
		const provider = new ModalSandboxProvider({ client });
		await expect(
			provider.execute(
				{ id: "sb-1", workspaceRoot: "/workspace" },
				authorized(),
				AbortSignal.abort(),
			),
		).rejects.toMatchObject({ code: "CANCELLED" });
		expect(calls.exec).toHaveLength(0);
	});

	test("rejects when the signal aborts during execution", async () => {
		const controller = new AbortController();
		const { client } = fakeClient({
			exec: async () => {
				controller.abort();
				return {
					exitCode: 0,
					stdout: "",
					stderr: "",
					timedOut: false,
				};
			},
		});
		const provider = new ModalSandboxProvider({ client });
		await expect(
			provider.execute(
				{ id: "sb-1", workspaceRoot: "/workspace" },
				authorized(),
				controller.signal,
			),
		).rejects.toMatchObject({ code: "CANCELLED" });
	});

	test.each([
		["fractional exit code", { exitCode: 0.5 }],
		["string exit code", { exitCode: "0" }],
		["non-string stdout", { stdout: 5 }],
		["non-boolean timedOut", { timedOut: "no" }],
		["null result", null],
	] as const)("rejects malformed results (%s)", async (_label, override) => {
		const { client } = fakeClient({
			exec: async () =>
				(override === null
					? null
					: {
							exitCode: 0,
							stdout: "",
							stderr: "",
							timedOut: false,
							...override,
						}) as unknown as ModalExecResult,
		});
		const provider = new ModalSandboxProvider({ client });
		await expect(
			provider.execute(
				{ id: "sb-1", workspaceRoot: "/workspace" },
				authorized(),
			),
		).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL" });
	});

	test("maps transport failures to PROVIDER_UNAVAILABLE", async () => {
		const { client } = fakeClient({
			exec: async () => {
				throw new Error("connection refused: secret host");
			},
		});
		const provider = new ModalSandboxProvider({ client });
		await expect(
			provider.execute(
				{ id: "sb-1", workspaceRoot: "/workspace" },
				authorized(),
			),
		).rejects.toMatchObject({
			code: "PROVIDER_UNAVAILABLE",
			message: "Modal sandbox execution failed",
		});
	});

	test("surfaces cancellation when an abort races a transport failure", async () => {
		const controller = new AbortController();
		const { client } = fakeClient({
			exec: async () => {
				controller.abort();
				throw new Error("transport failed");
			},
		});
		const provider = new ModalSandboxProvider({ client });
		await expect(
			provider.execute(
				{ id: "sb-1", workspaceRoot: "/workspace" },
				authorized(),
				controller.signal,
			),
		).rejects.toMatchObject({ code: "CANCELLED" });
	});

	test("clamps a backwards clock to a non-negative duration", async () => {
		const { client } = fakeClient();
		const provider = new ModalSandboxProvider({
			client,
			now: clock([2_000, 1_000]),
		});
		const result = await provider.execute(
			{ id: "sb-1", workspaceRoot: "/workspace" },
			authorized(),
		);
		expect(result.durationMs).toBe(0);
	});

	test("integrates with the policy dispatcher without exceeding its budget", async () => {
		const { client } = fakeClient({
			exec: async () => ({
				exitCode: 0,
				stdout: "ok",
				stderr: "",
				timedOut: false,
			}),
		});
		const provider = new ModalSandboxProvider({ client });
		const sandbox = await provider.create(spec);
		const result = await executeCommand(
			provider,
			sandbox,
			{ ...policy, maxOutputBytes: 64 },
			request,
		);
		expect(result.exitCode).toBe(0);
	});
});

describe("ModalSandboxProvider.destroy", () => {
	test("is idempotent and terminates exactly once", async () => {
		const { client, calls } = fakeClient();
		const provider = new ModalSandboxProvider({ client });
		const sandbox = { id: "sb-1", workspaceRoot: "/workspace" };
		await provider.destroy(sandbox);
		await provider.destroy(sandbox);
		await provider.destroy(sandbox);
		expect(calls.terminate).toEqual(["sb-1"]);
	});

	test("collapses concurrent destroys into one terminate call", async () => {
		const { client, calls } = fakeClient();
		const provider = new ModalSandboxProvider({ client });
		const sandbox = { id: "sb-1", workspaceRoot: "/workspace" };
		await Promise.all([
			provider.destroy(sandbox),
			provider.destroy(sandbox),
			provider.destroy(sandbox),
		]);
		expect(calls.terminate).toEqual(["sb-1"]);
	});

	test("tolerates an already-gone sandbox and records it as destroyed", async () => {
		const { client, calls } = fakeClient({
			terminate: async () => {
				throw new Error("sandbox not found");
			},
		});
		const provider = new ModalSandboxProvider({ client });
		const sandbox = { id: "sb-1", workspaceRoot: "/workspace" };
		await provider.destroy(sandbox);
		await provider.destroy(sandbox);
		expect(calls.terminate).toEqual(["sb-1"]);
	});

	test("rejects a malformed handle", async () => {
		const { client } = fakeClient();
		const provider = new ModalSandboxProvider({ client });
		await expect(
			provider.destroy({ id: "", workspaceRoot: "/workspace" }),
		).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL" });
	});
});

test("never spawns a host process", async () => {
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("host execution forbidden");
	});
	const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
		throw new Error("host execution forbidden");
	});
	try {
		const { client } = fakeClient();
		const provider = new ModalSandboxProvider({ client });
		const sandbox = await provider.create(spec);
		await provider.execute(sandbox, authorized());
		await provider.destroy(sandbox);
		expect(spawn).not.toHaveBeenCalled();
		expect(spawnSync).not.toHaveBeenCalled();
	} finally {
		spawn.mockRestore();
		spawnSync.mockRestore();
	}
});
