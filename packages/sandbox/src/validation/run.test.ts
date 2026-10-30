import { describe, expect, mock, spyOn, test } from "bun:test";
import { type ValidationReport, validationReportSchema } from "@isolate/shared";
import { SandboxError } from "../errors";
import type { AuthorizedCommand } from "../policy/command-policy";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
} from "../providers/types";
import {
	runValidationCommand,
	VALIDATION_OUTPUT_CAP_BYTES,
	type ValidationRunnerDeps,
} from "./run";

const sandbox: SandboxHandle = { id: "fixture", workspaceRoot: "/workspace" };
const repoPath = "/workspace/repo";

const OK: CommandResult = {
	exitCode: 0,
	stdout: "ok",
	stderr: "",
	durationMs: 1,
	timedOut: false,
	outputLimitExceeded: false,
};

function recording(output: CommandResult = OK) {
	let next = output;
	const execute = mock(
		async (
			_handle: SandboxHandle,
			_command: AuthorizedCommand,
			_signal?: AbortSignal,
			_stdin?: string,
		) => next,
	);
	const provider: SandboxProvider = {
		name: "recording-fake",
		create: mock(async () => sandbox),
		execute,
		destroy: mock(async () => {}),
	};
	return {
		provider,
		execute,
		set(value: CommandResult) {
			next = value;
		},
	};
}

function depsFor(
	provider: SandboxProvider,
	times: readonly number[] = [1000, 1250],
): ValidationRunnerDeps {
	let index = 0;
	return {
		provider,
		sandbox,
		repoPath,
		now: () => times[Math.min(index++, times.length - 1)],
	};
}

function expectValid(report: ValidationReport): void {
	expect(validationReportSchema.parse(report)).toEqual(report);
}

async function expectRefusal(
	promise: Promise<unknown>,
	execute: ReturnType<typeof recording>["execute"],
): Promise<void> {
	await expect(promise).rejects.toMatchObject({ code: "POLICY_DENIED" });
	expect(execute).not.toHaveBeenCalled();
}

describe("validation runner execution", () => {
	test("passes an allowlisted command as argv and maps exit 0 to passed", async () => {
		const { provider, execute } = recording();
		const outcome = await runValidationCommand(depsFor(provider), {
			command: "bun test",
			timeoutMs: 300_000,
		});

		expect(outcome.report).toEqual({
			command: "bun test",
			argv: ["bun", "test"],
			status: "passed",
			exitCode: 0,
			durationMs: 250,
			outputBytes: 2,
			truncated: false,
		});
		expect(outcome.output).toBe("ok");
		expectValid(outcome.report);
		expect(execute).toHaveBeenCalledTimes(1);

		const [, command, signal, stdin] = execute.mock.calls[0];
		expect(typeof command).toBe("object");
		expect("command" in command).toBe(false);
		expect(command.executable).toBe("bun");
		expect(Array.isArray(command.args)).toBe(true);
		expect(command.args).toEqual(["test"]);
		expect(command.cwd).toBe(repoPath);
		expect(command.timeoutMs).toBe(300_000);
		expect(command.maxOutputBytes).toBe(VALIDATION_OUTPUT_CAP_BYTES);
		expect(command.egress).toEqual({ mode: "deny" });
		expect(signal).toBeUndefined();
		expect(stdin).toBeUndefined();
	});

	test.each([
		["bun test", ["bun", "test"]],
		["bun run test", ["bun", "run", "test"]],
		["bun run test:unit", ["bun", "run", "test:unit"]],
		["bun run lint-workspace", ["bun", "run", "lint-workspace"]],
		["npm test", ["npm", "test"]],
		["npm run lint", ["npm", "run", "lint"]],
		["pytest", ["pytest"]],
		["cargo test", ["cargo", "test"]],
		["go test", ["go", "test"]],
		["bun \"run\" 'test'", ["bun", "run", "test"]],
		["  bun   test  ", ["bun", "test"]],
	])("tokenizes %j into %j without a shell", async (command, argv) => {
		const { provider, execute } = recording();
		const outcome = await runValidationCommand(depsFor(provider), {
			command,
			timeoutMs: 120_000,
		});
		expect(outcome.report.argv).toEqual(argv);
		expect(outcome.report.command).toBe(command);
		expect(outcome.report.status).toBe("passed");
		expectValid(outcome.report);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0][1].args).toEqual(argv.slice(1));
	});

	test("maps a non-zero exit to failed with the captured output", async () => {
		const { provider } = recording({
			...OK,
			exitCode: 1,
			stdout: "1 test failed\n",
			stderr: "stack\n",
		});
		const outcome = await runValidationCommand(depsFor(provider), {
			command: "bun test",
			timeoutMs: 60_000,
		});
		expect(outcome.report.status).toBe("failed");
		expect(outcome.report.exitCode).toBe(1);
		expect(outcome.report.truncated).toBe(false);
		expect(outcome.output).toBe("1 test failed\nstack\n");
		expect(outcome.report.outputBytes).toBe(
			Buffer.byteLength("1 test failed\nstack\n", "utf8"),
		);
		expectValid(outcome.report);
	});

	test("keeps the first 64 KiB and flags provider truncation", async () => {
		const { provider } = recording({
			...OK,
			stdout: "a".repeat(70_000),
			outputLimitExceeded: true,
		});
		const outcome = await runValidationCommand(depsFor(provider), {
			command: "pytest",
			timeoutMs: 60_000,
		});
		expect(outcome.report.status).toBe("passed");
		expect(outcome.report.truncated).toBe(true);
		expect(outcome.report.outputBytes).toBe(VALIDATION_OUTPUT_CAP_BYTES);
		expect(outcome.output).toHaveLength(VALIDATION_OUTPUT_CAP_BYTES);
		expectValid(outcome.report);
	});

	test("shares the byte cap between stderr and stdout on a code-point boundary", async () => {
		const { provider } = recording({
			...OK,
			stdout: "",
			stderr: "é".repeat(40_000),
			outputLimitExceeded: true,
		});
		const outcome = await runValidationCommand(depsFor(provider), {
			command: "cargo test",
			timeoutMs: 60_000,
		});
		expect(Buffer.byteLength(outcome.output, "utf8")).toBe(
			VALIDATION_OUTPUT_CAP_BYTES,
		);
		expect(outcome.output.includes("\uFFFD")).toBe(false);
		expect(outcome.report.truncated).toBe(true);
		expectValid(outcome.report);
	});

	test("clips a misbehaving provider that claims no truncation", async () => {
		const { provider } = recording({ ...OK, stdout: "b".repeat(70_000) });
		const outcome = await runValidationCommand(depsFor(provider), {
			command: "go test",
			timeoutMs: 60_000,
		});
		expect(outcome.output).toHaveLength(VALIDATION_OUTPUT_CAP_BYTES);
		expect(outcome.report.outputBytes).toBe(VALIDATION_OUTPUT_CAP_BYTES);
		expect(outcome.report.truncated).toBe(true);
		expectValid(outcome.report);
	});

	test.each([
		true,
		false,
	])("propagates a provider timeout (timedOut=%s) as a failed report", async (timedOut) => {
		const { provider } = recording({
			...OK,
			timedOut,
			durationMs: timedOut ? 1 : 900_001,
			stdout: "partial",
		});
		const outcome = await runValidationCommand(depsFor(provider), {
			command: "bun test",
			timeoutMs: 30_000,
		});
		expect(outcome.report.status).toBe("failed");
		expect(outcome.report.exitCode).toBe(124);
		expect(outcome.output).toBe("partial");
		expectValid(outcome.report);
	});

	test("uses the injected clock for the reported duration", async () => {
		const { provider } = recording();
		const outcome = await runValidationCommand(
			depsFor(provider, [5_000, 5_123]),
			{ command: "bun test", timeoutMs: 300_000 },
		);
		expect(outcome.report.durationMs).toBe(123);
	});

	test.each([
		["SandboxError", new SandboxError("PROVIDER_UNAVAILABLE", "gone")],
		["Error", new Error("socket reset")],
	])("maps a %s thrown after authorization to a never-ran failure report", async (_label, thrown) => {
		const { provider } = recording();
		provider.execute = mock(async () => {
			throw thrown;
		});
		const outcome = await runValidationCommand(depsFor(provider), {
			command: "bun test",
			timeoutMs: 60_000,
		});
		expect(outcome.report).toEqual({
			command: "bun test",
			argv: ["bun", "test"],
			status: "failed",
			exitCode: -1,
			durationMs: 250,
			outputBytes: 0,
			truncated: false,
		});
		expect(outcome.output).toBe("");
		expectValid(outcome.report);
	});

	test("re-throws cancellation instead of recording a validation failure", async () => {
		const { provider } = recording();
		provider.execute = mock(async () => {
			throw new SandboxError("CANCELLED", "Command was cancelled");
		});
		await expect(
			runValidationCommand(depsFor(provider), {
				command: "bun test",
				timeoutMs: 60_000,
			}),
		).rejects.toMatchObject({ code: "CANCELLED" });
	});

	test("never spawns a host process for a valid command", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("host execution forbidden");
		});
		const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
			throw new Error("host execution forbidden");
		});
		try {
			const { provider, execute } = recording();
			await runValidationCommand(depsFor(provider), {
				command: "bun test",
				timeoutMs: 60_000,
			});
			expect(execute).toHaveBeenCalledTimes(1);
			expect(spawn).not.toHaveBeenCalled();
			expect(spawnSync).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
			spawnSync.mockRestore();
		}
	});

	test("accepts both timeout bounds and forwards them to the policy", async () => {
		for (const timeoutMs of [1_000, 900_000]) {
			const { provider, execute } = recording();
			await runValidationCommand(depsFor(provider), {
				command: "bun test",
				timeoutMs,
			});
			expect(execute.mock.calls[0][1].timeoutMs).toBe(timeoutMs);
		}
	});
});

describe("validation runner refusals stay before the provider", () => {
	test.each([
		["", "empty command"],
		["   ", "whitespace-only command"],
		["x".repeat(513), "oversize command"],
		[`bun ${Array.from({ length: 32 }, () => "test").join(" ")}`, "33 tokens"],
		[`pytest ${"a".repeat(257)}`, "oversize token"],
		["bun test;whoami", "semicolon"],
		["bun test|cat", "pipe"],
		["bun test&&true", "ampersand"],
		["bun test>out.txt", "redirect"],
		["bun test<input.txt", "redirect in"],
		["bun test $HOME", "variable"],
		["bun test `id`", "backtick"],
		["bun test\nwhoami", "newline"],
		["bun\ttest", "tab"],
		["bun test (whoami)", "parentheses"],
		["bun test )", "closing parenthesis"],
		["bun test 'unterminated", "unterminated quote"],
		['pytest ""', "empty quoted token"],
		["sh -c 'bun test'", "shell executable"],
		["./bun test", "relative executable"],
		["git diff --stat", "read-only git"],
		["bun test --watch", "extra flag"],
		["bun run ../evil", "path script"],
		["bun run UPPER", "uppercase script"],
		["npm install", "unknown npm verb"],
		["pytest --version", "pytest flag"],
		["go test ./...", "go package argument"],
	])("refuses %j (%s) without calling the provider", async (command) => {
		const { provider, execute } = recording();
		await expectRefusal(
			runValidationCommand(depsFor(provider), { command, timeoutMs: 300_000 }),
			execute,
		);
	});

	test.each([
		0,
		-1,
		999,
		900_001,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("refuses out-of-bounds timeout %s", async (timeoutMs) => {
		const { provider, execute } = recording();
		await expectRefusal(
			runValidationCommand(depsFor(provider), {
				command: "bun test",
				timeoutMs,
			}),
			execute,
		);
	});

	test("refuses a repository path outside the sandbox root", async () => {
		const { provider, execute } = recording();
		await expectRefusal(
			runValidationCommand(
				{ ...depsFor(provider), repoPath: "/etc/repo" },
				{ command: "bun test", timeoutMs: 300_000 },
			),
			execute,
		);
	});

	test("refuses a missing provider or sandbox handle", async () => {
		const { provider, execute } = recording();
		await expectRefusal(
			runValidationCommand(
				{ ...depsFor(provider), provider: {} as SandboxProvider },
				{ command: "bun test", timeoutMs: 300_000 },
			),
			execute,
		);
		await expectRefusal(
			runValidationCommand(
				{
					...depsFor(provider),
					sandbox: { id: "fixture" } as SandboxHandle,
				},
				{ command: "bun test", timeoutMs: 300_000 },
			),
			execute,
		);
	});
});
