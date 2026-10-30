import { executeCommand } from "../packages/sandbox/src/execute";
import { GIT_OPTIONS } from "../packages/sandbox/src/git/index";
import type {
	EgressPolicy,
	SandboxHandle,
	SandboxProvider,
} from "../packages/sandbox/src/index";
import {
	createSandboxEnvResolver,
	selectGitHubTokenProvider,
	selectSandboxProvider,
} from "../apps/worker/src/runtime-composition";

/**
 * ONE diagnostic sandbox (no inference) that replays the exact git argv the
 * workspace helper uses, printing bounded, redacted output. This exists only
 * to explain a `GIT_FAILED` that the production handler intentionally hides.
 */

if (process.env.DIAGNOSE_LIVE !== "1") {
	console.log("Set DIAGNOSE_LIVE=1 to run the clone diagnostic.");
	process.exit(0);
}

const repoFullName =
	process.env.LIVE_REPO_FULL_NAME?.trim() || "ivory-26/agent-bank";
const repoUrl = `https://github.com/${repoFullName}`;
const branch = `task/diag-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
const deny: EgressPolicy = { mode: "deny" };
const allow: EgressPolicy = {
	mode: "allowlist",
	hosts: ["github.com", "codeload.github.com"],
};

function redact(value: string): string {
	return value
		.replace(/ghs_[A-Za-z0-9]+/g, "[redacted]")
		.replace(/Basic [A-Za-z0-9+/=]+/g, "Basic [redacted]")
		.slice(0, 400);
}

async function run(
	provider: SandboxProvider,
	sandbox: SandboxHandle,
	executable: string,
	args: readonly string[],
	options: {
		cwd: string;
		timeoutMs: number;
		maxOutputBytes: number;
		egress: EgressPolicy;
	},
) {
	const result = await executeCommand(
		provider,
		sandbox,
		{
			workspaceRoot: sandbox.workspaceRoot,
			allowlist: [
				{
					executable,
					args: args.map((value) => ({ kind: "literal" as const, value })),
				},
			],
			maxTimeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			egress: options.egress,
		},
		{
			executable,
			args,
			cwd: options.cwd,
			timeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			egress: options.egress,
		},
		undefined,
		undefined,
		{ surfaceLimits: true },
	);
	return {
		argv: [executable, ...args].join(" ").slice(0, 160),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		outputLimitExceeded: result.outputLimitExceeded,
		durationMs: result.durationMs,
		stdout: redact(result.stdout.trim()),
		stderr: redact(result.stderr.trim()),
	};
}

const broker = selectGitHubTokenProvider(process.env);
if (!broker) {
	console.error("GitHub broker is not configured");
	process.exit(1);
}
const env = await createSandboxEnvResolver(broker)({
	organizationId: "diagnostic",
	taskId: "diagnostic",
	repoUrl,
});

// Same selection (and therefore the same image + setup layer) as the worker.
const selected = await selectSandboxProvider({
	...process.env,
	SANDBOX_PROVIDER: "modal",
});
if (!selected.real) {
	console.error("Modal provider is not configured");
	process.exit(1);
}
const provider = selected.provider;
let sandbox: SandboxHandle | undefined;
const results: unknown[] = [];
try {
	sandbox = await provider.create({
		workspaceRoot: "/tmp",
		lifetimeMs: 120_000,
		idleTimeoutMs: 60_000,
		memoryMb: 512,
		cpuCount: 0.125,
		egress: allow,
		env,
	});
	const local = { timeoutMs: 30_000, maxOutputBytes: 16_384 };
	const toolchain = { timeoutMs: 10_000, maxOutputBytes: 4_096 };
	results.push(
		await run(provider, sandbox, "git", ["--version"], {
			cwd: "/tmp",
			...toolchain,
			egress: deny,
		}),
	);
	results.push(
		await run(provider, sandbox, "test", ["-L", "/tmp/repo"], {
			cwd: "/tmp",
			...local,
			egress: deny,
		}),
	);
	results.push(
		await run(provider, sandbox, "ls", ["-A", "--", "/tmp/repo"], {
			cwd: "/tmp",
			...local,
			egress: deny,
		}),
	);
	results.push(
		await run(
			provider,
			sandbox,
			"git",
			[
				...GIT_OPTIONS,
				"-c",
				"protocol.https.allow=always",
				"clone",
				"--depth",
				"1",
				"--single-branch",
				"--branch",
				"main",
				"--no-tags",
				repoUrl,
				"/tmp/repo",
			],
			{ cwd: "/tmp", timeoutMs: 120_000, maxOutputBytes: 65_536, egress: allow },
		),
	);
	results.push(
		await run(provider, sandbox, "git", [...GIT_OPTIONS, "rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: "/tmp/repo",
			...local,
			egress: deny,
		}),
	);
	results.push(
		await run(provider, sandbox, "git", [...GIT_OPTIONS, "switch", "-c", branch], {
			cwd: "/tmp/repo",
			...local,
			egress: deny,
		}),
	);
	console.log(JSON.stringify(results, null, 2));
} catch (error) {
	console.error(
		"DIAGNOSTIC FAILED:",
		error instanceof Error ? redact(error.message) : "unknown",
	);
	console.log(JSON.stringify(results, null, 2));
	process.exitCode = 1;
} finally {
	if (sandbox) {
		await provider.destroy(sandbox);
		console.log("diagnostic sandbox destroyed");
	}
}
