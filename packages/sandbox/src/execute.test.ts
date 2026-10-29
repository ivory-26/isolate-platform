import { describe, expect, mock, spyOn, test } from "bun:test";
import { executeCommand } from "./execute";
import {
	type AuthorizedCommand,
	type CommandPolicy,
	type CommandRequest,
	commandPolicy,
} from "./policy/command-policy";
import { NullProvider } from "./providers/null";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
	SandboxSpec,
} from "./providers/types";

const sandbox: SandboxHandle = { id: "fixture", workspaceRoot: "/workspace" };
const policy: CommandPolicy = {
	workspaceRoot: "/workspace",
	allowlist: [
		{ executable: "git", args: [{ kind: "literal", value: "--version" }] },
	],
	maxTimeoutMs: 1000,
	maxOutputBytes: 64,
	egress: { mode: "deny" },
};
const request: CommandRequest = {
	executable: "git",
	args: ["--version"],
	cwd: "/workspace/repo",
	timeoutMs: 1000,
	maxOutputBytes: 64,
};
const result: CommandResult = {
	exitCode: 0,
	stdout: "ok",
	stderr: "",
	durationMs: 1,
	timedOut: false,
	outputLimitExceeded: false,
};
function fake(output: CommandResult = result) {
	const execute = mock(
		async (
			_handle: SandboxHandle,
			_command: AuthorizedCommand,
			_signal?: AbortSignal,
		) => output,
	);
	const provider: SandboxProvider = {
		name: "recording-fake",
		create: mock(async () => sandbox),
		execute,
		destroy: mock(async () => {}),
	};
	return { provider, execute };
}

describe("NullProvider", () => {
	test("denies provisioning and every execution, including valid and forged commands, with no host spawn", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("host execution forbidden");
		});
		const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
			throw new Error("host execution forbidden");
		});
		try {
			const provider = new NullProvider();
			const spec: SandboxSpec = {
				workspaceRoot: "/workspace",
				lifetimeMs: 1000,
				memoryMb: 256,
				cpuCount: 1,
				egress: { mode: "deny" },
			};
			await expect(provider.create(spec)).rejects.toMatchObject({
				code: "PROVIDER_UNAVAILABLE",
			});
			await expect(
				provider.execute(sandbox, commandPolicy(policy, request)),
			).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
			await expect(
				provider.execute(sandbox, {} as AuthorizedCommand),
			).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
			await expect(
				executeCommand(provider, sandbox, policy, request),
			).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
			await provider.destroy(sandbox);
			await provider.destroy(sandbox);
			expect(spawn).not.toHaveBeenCalled();
			expect(spawnSync).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
			spawnSync.mockRestore();
		}
	});

	test("type contract rejects raw or mutated commands", () => {
		function compileTime(
			provider: SandboxProvider,
			command: AuthorizedCommand,
		): void {
			// @ts-expect-error Raw requests must pass commandPolicy before provider dispatch.
			void provider.execute(sandbox, request);
			// @ts-expect-error Authorized argv is immutable.
			command.args.push("--exec");
		}
		expect(typeof compileTime).toBe("function");
	});
});

describe("validated adapter dispatch", () => {
	test("never reaches adapter for policy, sandbox-root, or pre-abort denials", async () => {
		const { provider, execute } = fake();
		await expect(
			executeCommand(provider, sandbox, policy, {
				...request,
				args: ["--exec"],
			}),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		await expect(
			executeCommand(
				provider,
				{ ...sandbox, workspaceRoot: "/other" },
				policy,
				request,
			),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		await expect(
			executeCommand(provider, sandbox, policy, {
				...request,
				egress: { mode: "allowlist", hosts: ["github.com"] },
			}),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		await expect(
			executeCommand(provider, sandbox, policy, request, AbortSignal.abort()),
		).rejects.toMatchObject({ code: "CANCELLED" });
		expect(execute).not.toHaveBeenCalled();
	});

	test("passes only authorized argv and cancellation to adapter", async () => {
		const { provider, execute } = fake();
		const signal = new AbortController().signal;
		const output = await executeCommand(
			provider,
			sandbox,
			policy,
			request,
			signal,
		);
		expect(output).toEqual(result);
		expect(Object.isFrozen(output)).toBe(true);
		expect(execute.mock.calls[0][0]).toBe(sandbox);
		expect(execute.mock.calls[0][1].egress).toEqual({ mode: "deny" });
		expect(execute.mock.calls[0][2]).toBe(signal);
	});

	test.each([
		[{ timedOut: true }, "TIMEOUT"],
		[{ durationMs: 1001 }, "TIMEOUT"],
		[{ outputLimitExceeded: true }, "OUTPUT_LIMIT"],
		[{ stdout: "x".repeat(65) }, "OUTPUT_LIMIT"],
		[{ stdout: "a".repeat(32), stderr: "b".repeat(33) }, "OUTPUT_LIMIT"],
		[{ stdout: "é".repeat(33) }, "OUTPUT_LIMIT"],
		[{ durationMs: NaN }, "PROVIDER_PROTOCOL"],
		[{ exitCode: 0.5 }, "PROVIDER_PROTOCOL"],
	] as const)("rejects unsafe result %j with %s", async (override, code) => {
		const { provider } = fake({ ...result, ...override });
		await expect(
			executeCommand(provider, sandbox, policy, request),
		).rejects.toMatchObject({ code });
	});

	test("cancellation during dispatch is surfaced even if adapter reports success", async () => {
		const { provider } = fake();
		const controller = new AbortController();
		provider.execute = async () => {
			controller.abort();
			return result;
		};
		await expect(
			executeCommand(provider, sandbox, policy, request, controller.signal),
		).rejects.toMatchObject({ code: "CANCELLED" });
	});
});

test("production barrel has no reachable host-execution or fixture adapter dependency", async () => {
	const build = await Bun.build({
		entrypoints: [`${import.meta.dir}/index.ts`],
		target: "bun",
	});
	expect(build.success).toBe(true);
	const source = await build.outputs[0].text();
	for (const forbidden of [
		"child_process",
		"Bun.spawn",
		"TRUSTED-GENERATED-FIXTURE-ONLY",
		"mkdtempSync",
	]) {
		expect(source).not.toContain(forbidden);
	}
});
