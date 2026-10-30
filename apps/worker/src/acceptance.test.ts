import { describe, expect, test } from "bun:test";
import type { SandboxToolBackend } from "@isolate/mastra";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
	SandboxSpec,
} from "@isolate/sandbox";
import { SandboxError } from "@isolate/sandbox";
import type { AcceptanceCheck, AcceptanceReport } from "@isolate/shared";
import { acceptanceReportSchema, PlatformError } from "@isolate/shared";
import {
	acceptanceReportArtifact,
	invalidAcceptanceReport,
	MAX_ACCEPTANCE_CHECKS,
	MAX_ACCEPTANCE_READ_BYTES,
	runAcceptanceChecks,
} from "./acceptance";

/* ---------------------------------- fakes --------------------------------- */

const sandbox: SandboxHandle = {
	id: "sbx_accept",
	workspaceRoot: "/workspace",
};
const REPO_PATH = "/workspace/repo";

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
	return {
		exitCode: 0,
		stdout: "ok",
		stderr: "",
		durationMs: 3,
		timedOut: false,
		outputLimitExceeded: false,
		...overrides,
	};
}

class FakeProvider implements SandboxProvider {
	readonly name = "fake-acceptance";
	executeCalls: Array<{ executable: string; args: readonly string[] }> = [];
	result: CommandResult = commandResult();

	async create(_spec: SandboxSpec): Promise<SandboxHandle> {
		return sandbox;
	}

	async execute(
		_handle: SandboxHandle,
		command: unknown,
	): Promise<CommandResult> {
		const argv = command as { executable: string; args: readonly string[] };
		this.executeCalls.push({ executable: argv.executable, args: argv.args });
		return this.result;
	}

	async destroy(): Promise<void> {}
}

type ReadMap = Record<string, { content: string } | { error: unknown }>;

class FakeBackend implements SandboxToolBackend {
	readPaths: string[] = [];
	maxBytesSeen: Array<number | undefined> = [];

	constructor(private readonly files: ReadMap) {}

	async readFile(
		path: string,
		options?: { maxBytes?: number },
	): Promise<{ content: string; truncated: boolean }> {
		this.readPaths.push(path);
		this.maxBytesSeen.push(options?.maxBytes);
		const entry = this.files[path];
		if (entry === undefined) {
			throw new PlatformError("NOT_FOUND", "file could not be read");
		}
		if ("error" in entry) throw entry.error;
		return { content: entry.content, truncated: false };
	}

	async listFiles(): Promise<readonly string[]> {
		return [];
	}

	async search(): Promise<readonly []> {
		return [];
	}

	async exec(): Promise<CommandResult> {
		return commandResult();
	}

	async git(): Promise<CommandResult> {
		return commandResult();
	}
}

class RecordingSinks {
	order: string[] = [];
	totals: number[] = [];
	reports: AcceptanceReport[] = [];
	artifacts: Array<{ content: string; sha256: string }> = [];

	readonly sinks = {
		started: ({ total }: { total: number }) => {
			this.order.push("started");
			this.totals.push(total);
		},
		finished: (report: AcceptanceReport) => {
			this.order.push("finished");
			this.reports.push(report);
		},
		artifact: (input: { content: string; sha256: string }) => {
			this.order.push("artifact");
			this.artifacts.push(input);
		},
	};
}

class FakeClock {
	current = 10_000;
	now = (): number => this.current;
}

function depsFor(
	provider: FakeProvider,
	backend: SandboxToolBackend | null,
	checks: readonly AcceptanceCheck[],
	options: {
		clock?: FakeClock;
		signal?: AbortSignal;
		sinks?: RecordingSinks["sinks"];
		timeoutMs?: number;
	} = {},
) {
	return {
		provider,
		sandbox,
		repoPath: REPO_PATH,
		backend,
		checks,
		...(options.clock === undefined ? {} : { now: options.clock.now }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.sinks === undefined ? {} : { sinks: options.sinks }),
		...(options.timeoutMs === undefined
			? {}
			: { timeoutMs: options.timeoutMs }),
	};
}

/* ---------------------------------- tests --------------------------------- */

describe("acceptance verifier — path_exists", () => {
	test("passes when the file is readable through the bounded backend", async () => {
		const backend = new FakeBackend({ "LIVE.md": { content: "hello" } });
		const report = await runAcceptanceChecks(
			depsFor(new FakeProvider(), backend, [
				{ kind: "path_exists", path: "LIVE.md" },
			]),
		);
		expect(report).toMatchObject({
			passed: true,
			matched: 1,
			total: 1,
			checks: [{ kind: "path_exists", target: "LIVE.md", passed: true }],
		});
		expect(report.durationMs).toBeGreaterThanOrEqual(0);
		expect(acceptanceReportSchema.parse(report)).toEqual(report);
		expect(backend.readPaths).toEqual(["LIVE.md"]);
		expect(backend.maxBytesSeen).toEqual([MAX_ACCEPTANCE_READ_BYTES]);
	});

	test("fails when the file is missing, without leaking a backend message", async () => {
		const backend = new FakeBackend({});
		const report = await runAcceptanceChecks(
			depsFor(new FakeProvider(), backend, [
				{ kind: "path_exists", path: "missing.ts" },
			]),
		);
		expect(report.passed).toBe(false);
		expect(report.matched).toBe(0);
		expect(report.checks[0]).toEqual({
			kind: "path_exists",
			target: "missing.ts",
			passed: false,
			detail: "file not found",
		});
	});

	test("fails closed when no read surface was provisioned", async () => {
		const report = await runAcceptanceChecks(
			depsFor(new FakeProvider(), null, [
				{ kind: "path_exists", path: "LIVE.md" },
			]),
		);
		expect(report.checks[0]?.detail).toBe("read surface unavailable");
	});

	test("rejects a traversal path before touching the backend", async () => {
		const backend = new FakeBackend({});
		const report = await runAcceptanceChecks(
			depsFor(new FakeProvider(), backend, [
				{ kind: "path_exists", path: "../etc/passwd" },
			]),
		);
		expect(report.checks[0]?.detail).toBe("invalid workspace path");
		expect(backend.readPaths).toEqual([]);
	});
});

describe("acceptance verifier — content_matches", () => {
	test("passes on a match and never stores or echoes the file content", async () => {
		const backend = new FakeBackend({
			"src/answer.ts": { content: "const SECRET_TOKEN = 'abc123';\nexport {}" },
		});
		const sinks = new RecordingSinks();
		const report = await runAcceptanceChecks(
			depsFor(
				new FakeProvider(),
				backend,
				[
					{
						kind: "content_matches",
						path: "src/answer.ts",
						pattern: "SECRET_TOKEN",
					},
				],
				{ sinks: sinks.sinks },
			),
		);
		expect(report.passed).toBe(true);
		// Neither the report nor the artifact may carry file content.
		const serialized = `${JSON.stringify(report)}${JSON.stringify(sinks.artifacts)}`;
		expect(serialized).not.toContain("abc123");
		expect(serialized).not.toContain("const SECRET_TOKEN");
	});

	test("fails when the pattern does not match", async () => {
		const backend = new FakeBackend({ "a.txt": { content: "nothing here" } });
		const report = await runAcceptanceChecks(
			depsFor(new FakeProvider(), backend, [
				{ kind: "content_matches", path: "a.txt", pattern: "^done$" },
			]),
		);
		expect(report.checks[0]).toEqual({
			kind: "content_matches",
			target: "a.txt",
			passed: false,
			detail: "pattern not matched",
		});
	});

	test("an invalid regular expression fails the check, not the runner", async () => {
		const backend = new FakeBackend({ "a.txt": { content: "x" } });
		const report = await runAcceptanceChecks(
			depsFor(new FakeProvider(), backend, [
				{ kind: "content_matches", path: "a.txt", pattern: "([a-z" },
			]),
		);
		expect(report.passed).toBe(false);
		expect(report.checks[0]?.detail).toBe("invalid pattern");
	});

	test("a missing file fails with a bounded detail", async () => {
		const report = await runAcceptanceChecks(
			depsFor(new FakeProvider(), new FakeBackend({}), [
				{ kind: "content_matches", path: "nope.txt", pattern: "x" },
			]),
		);
		expect(report.checks[0]?.detail).toBe("file not found");
	});
});

describe("acceptance verifier — command_exit_zero", () => {
	test("runs an allowlisted command argv-only and passes on exit 0", async () => {
		const provider = new FakeProvider();
		const report = await runAcceptanceChecks(
			depsFor(provider, null, [
				{ kind: "command_exit_zero", command: "bun test live.test.ts" },
			]),
		);
		expect(report.passed).toBe(true);
		expect(provider.executeCalls).toEqual([
			{ executable: "bun", args: ["test", "live.test.ts"] },
		]);
	});

	test("fails on a non-zero exit with the exit code only", async () => {
		const provider = new FakeProvider();
		provider.result = commandResult({ exitCode: 2, stderr: "boom" });
		const report = await runAcceptanceChecks(
			depsFor(provider, null, [
				{ kind: "command_exit_zero", command: "bun test" },
			]),
		);
		expect(report.checks[0]).toEqual({
			kind: "command_exit_zero",
			target: "bun test",
			passed: false,
			detail: "command exited 2",
		});
		expect(JSON.stringify(report)).not.toContain("boom");
	});

	test("a refused command fails the check without calling the provider", async () => {
		const provider = new FakeProvider();
		const report = await runAcceptanceChecks(
			depsFor(provider, null, [
				{ kind: "command_exit_zero", command: "sh -c whoami" },
			]),
		);
		expect(report.checks[0]?.detail).toBe("command refused by policy");
		expect(provider.executeCalls).toEqual([]);
	});

	test("a timeout is reported as a timeout, not an exit code", async () => {
		const provider = new FakeProvider();
		provider.result = commandResult({
			timedOut: true,
			durationMs: 5_000,
			exitCode: 0,
		});
		const report = await runAcceptanceChecks(
			depsFor(provider, null, [
				{ kind: "command_exit_zero", command: "bun test" },
			]),
		);
		expect(report.checks[0]?.detail).toBe("command timed out");
	});
});

describe("acceptance verifier — report, sinks and bounds", () => {
	test("emits started, finished and one bounded artifact in order", async () => {
		const sinks = new RecordingSinks();
		const backend = new FakeBackend({
			"A.md": { content: "a" },
			"B.md": { content: "b" },
		});
		const report = await runAcceptanceChecks(
			depsFor(
				new FakeProvider(),
				backend,
				[
					{ kind: "path_exists", path: "A.md" },
					{ kind: "path_exists", path: "B.md" },
				],
				{ sinks: sinks.sinks },
			),
		);
		expect(sinks.order).toEqual(["started", "finished", "artifact"]);
		expect(sinks.totals).toEqual([2]);
		expect(sinks.reports).toEqual([report]);
		expect(sinks.artifacts).toEqual([acceptanceReportArtifact(report)]);
		expect(JSON.parse(sinks.artifacts[0]?.content ?? "")).toEqual(report);
	});

	test("uses the injected clock for the total duration", async () => {
		const clock = new FakeClock();
		const backend = new FakeBackend({ "A.md": { content: "a" } });
		const pending = runAcceptanceChecks(
			depsFor(
				new FakeProvider(),
				backend,
				[{ kind: "path_exists", path: "A.md" }],
				{ clock },
			),
		);
		clock.current += 1_250;
		const report = await pending;
		expect(report.durationMs).toBe(1_250);
	});

	test("keeps unmatched checks failing the whole report", async () => {
		const backend = new FakeBackend({ "A.md": { content: "a" } });
		const report = await runAcceptanceChecks(
			depsFor(new FakeProvider(), backend, [
				{ kind: "path_exists", path: "A.md" },
				{ kind: "path_exists", path: "B.md" },
			]),
		);
		expect(report).toMatchObject({ passed: false, matched: 1, total: 2 });
	});

	test("evaluates at most 32 checks", async () => {
		const backend = new FakeBackend({});
		const checks: AcceptanceCheck[] = Array.from(
			{ length: MAX_ACCEPTANCE_CHECKS + 8 },
			(_, index) => ({ kind: "path_exists" as const, path: `f${index}.md` }),
		);
		const report = await runAcceptanceChecks(
			depsFor(new FakeProvider(), backend, checks),
		);
		expect(report.total).toBe(MAX_ACCEPTANCE_CHECKS);
		expect(backend.readPaths).toHaveLength(MAX_ACCEPTANCE_CHECKS);
	});

	test("an aborted signal cancels with the bounded sandbox code", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runAcceptanceChecks(
				depsFor(
					new FakeProvider(),
					new FakeBackend({ "A.md": { content: "a" } }),
					[{ kind: "path_exists", path: "A.md" }],
					{ signal: controller.signal },
				),
			),
		).rejects.toMatchObject({ code: "CANCELLED" });
	});

	test("a backend cancellation propagates instead of recording a failure", async () => {
		const backend = new FakeBackend({
			"A.md": { error: new SandboxError("CANCELLED", "cancelled") },
		});
		await expect(
			runAcceptanceChecks(
				depsFor(new FakeProvider(), backend, [
					{ kind: "path_exists", path: "A.md" },
				]),
			),
		).rejects.toMatchObject({ code: "CANCELLED" });
	});

	test("invalidAcceptanceReport is bounded and never passes", () => {
		expect(invalidAcceptanceReport(0)).toEqual({
			passed: false,
			matched: 0,
			total: 0,
			checks: [],
			durationMs: 0,
		});
		expect(invalidAcceptanceReport(1_000).total).toBe(MAX_ACCEPTANCE_CHECKS);
		expect(invalidAcceptanceReport(-5).total).toBe(0);
	});
});
