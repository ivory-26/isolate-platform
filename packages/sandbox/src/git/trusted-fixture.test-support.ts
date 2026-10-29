/** TEST ONLY. Never import into the production barrel or point at existing repositories. */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SandboxError } from "../errors";
import { validateSandboxPath } from "../policy/paths";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
} from "../providers/types";
import { taskBranchName } from "./index";

const SAFE_OPTIONS = [
	"--no-pager",
	"--no-optional-locks",
	"--no-replace-objects",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.attributesFile=/dev/null",
	"-c",
	"core.sshCommand=false",
	"-c",
	"credential.helper=",
	"-c",
	"protocol.allow=never",
	"-c",
	"submodule.recurse=false",
	"-c",
	"maintenance.auto=false",
	"-c",
	"gc.auto=0",
];

/** The only host Git is restricted to a new, empty-template fixture this function owns. */
export function createTrustedFixture() {
	const git = Bun.which("git");
	if (!git)
		throw new Error(
			"Offline Git fixture tests require an installed Git binary",
		);
	const directory = realpathSync(
		mkdtempSync(join(tmpdir(), "isolate-sandbox-")),
	);
	const repoPath = join(directory, "repo");
	const emptyTemplate = join(directory, "empty-template");
	mkdirSync(emptyTemplate);
	const sandbox: SandboxHandle = Object.freeze({
		id: crypto.randomUUID(),
		workspaceRoot: "/workspace",
	});
	let closed = false;
	const created = new Set<string>();
	const env = {
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		HOME: directory,
		USERPROFILE: directory,
		XDG_CONFIG_HOME: directory,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_COUNT: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_ALLOW_PROTOCOL: "",
		GIT_PROTOCOL_FROM_USER: "0",
		GIT_LFS_SKIP_SMUDGE: "1",
	};

	function contained(path: string): string {
		const target = resolve(path);
		const diff = relative(directory, target);
		if (diff.startsWith("..") || isAbsolute(diff))
			throw new Error("Fixture path escaped temp directory");
		let ancestor = target;
		while (!existsSync(ancestor)) ancestor = dirname(ancestor);
		const realDiff = relative(directory, realpathSync(ancestor));
		if (realDiff.startsWith("..") || isAbsolute(realDiff))
			throw new Error("Fixture symlink escaped temp directory");
		return target;
	}

	function run(
		args: readonly string[],
		cwd = repoPath,
		timeoutMs = 5000,
		maxOutputBytes = 16384,
	): CommandResult {
		if (closed) throw new Error("Fixture has been disposed");
		contained(cwd);
		const start = performance.now();
		const output = spawnSync(git as string, [...SAFE_OPTIONS, ...args], {
			cwd,
			env,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: maxOutputBytes,
			windowsHide: true,
			shell: false,
			killSignal: "SIGKILL",
		});
		const code =
			output.error && "code" in output.error ? output.error.code : undefined;
		const stdout = output.stdout ?? "";
		const stderr = output.stderr ?? "";
		const exceeded =
			code === "ENOBUFS" ||
			Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes;
		return {
			exitCode: output.status ?? -1,
			stdout: exceeded ? "" : stdout,
			stderr: exceeded ? "" : stderr,
			durationMs: performance.now() - start,
			timedOut: code === "ETIMEDOUT",
			outputLimitExceeded: exceeded,
		};
	}

	function seed(args: readonly string[], cwd = repoPath): string {
		const fixed = [
			["branch", "--show-current"],
			["add", "--", ".gitattributes", "guard.txt"],
			[
				"-c",
				"user.name=Offline Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"--allow-empty",
				"--no-gpg-sign",
				"-m",
				"Fixture",
			],
			[
				"-c",
				"user.name=Offline Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"--no-gpg-sign",
				"-m",
				"Guard fixture",
			],
			["config", "core.hooksPath", join(repoPath, ".git", "fixture-hooks")],
			["config", "core.fsmonitor", "printf executed > fsmonitor-executed"],
			["config", "filter.guard.smudge", "printf executed > filter-executed"],
			["config", "filter.guard.required", "true"],
		];
		const init =
			JSON.stringify(args) ===
			JSON.stringify([
				"init",
				`--template=${emptyTemplate}`,
				"--initial-branch=main",
				"--",
				repoPath,
			]);
		const inspectRef =
			(args.length === 2 &&
				args[0] === "rev-parse" &&
				args[1].startsWith("refs/heads/task/")) ||
			(args.length === 3 &&
				args[0] === "show-ref" &&
				args[1] === "--verify" &&
				args[2].startsWith("refs/heads/task/"));
		const ref = args.at(-1);
		if (
			inspectRef &&
			ref !==
				"refs/heads/" +
					taskBranchName(ref?.slice("refs/heads/task/".length) ?? "")
		)
			throw new Error("Invalid fixture ref");
		const allowed =
			fixed.some((shape) => JSON.stringify(shape) === JSON.stringify(args)) ||
			inspectRef;
		if (!(init ? cwd === directory : cwd === repoPath && allowed))
			throw new Error("Fixture setup operation is not allowlisted");
		const result = run(args, cwd);
		if (
			result.exitCode !== 0 ||
			result.timedOut ||
			result.outputLimitExceeded
		) {
			throw new Error(`Trusted fixture setup failed: ${result.stderr}`);
		}
		return result.stdout;
	}
	try {
		seed(
			[
				"init",
				`--template=${emptyTemplate}`,
				"--initial-branch=main",
				"--",
				repoPath,
			],
			directory,
		);
		seed([
			"-c",
			"user.name=Offline Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"--no-gpg-sign",
			"-m",
			"Fixture",
		]);
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}

	function hostPath(virtual: string): string {
		validateSandboxPath("/workspace", virtual);
		return contained(join(directory, virtual.slice("/workspace/".length)));
	}

	const provider: SandboxProvider = {
		name: "TRUSTED-GENERATED-FIXTURE-ONLY",
		async create() {
			throw new Error("Fixtures cannot provision real sandboxes");
		},
		async execute(handle, command, signal) {
			if (
				closed ||
				handle.id !== sandbox.id ||
				handle.workspaceRoot !== "/workspace" ||
				command.executable !== "git" ||
				command.cwd !== "/workspace/repo" ||
				command.egress.mode !== "deny"
			) {
				throw new SandboxError(
					"POLICY_DENIED",
					"Fixture refuses external execution",
				);
			}
			if (signal?.aborted)
				throw new SandboxError("CANCELLED", "Fixture command cancelled");
			if (lstatSync(join(repoPath, ".git")).isSymbolicLink())
				throw new Error("Fixture repository replaced");
			if (
				JSON.stringify(command.args.slice(0, SAFE_OPTIONS.length)) !==
				JSON.stringify(SAFE_OPTIONS)
			) {
				throw new Error("Fixture requires hardened Git options");
			}
			const args = command.args.slice(SAFE_OPTIONS.length);
			let virtualPath: string | undefined;
			if (
				JSON.stringify(args) ===
				JSON.stringify([
					"rev-parse",
					"--path-format=absolute",
					"--show-toplevel",
				])
			) {
				// Exact read-only operation on the fresh fixture.
			} else if (
				args.length === 5 &&
				args[0] === "branch" &&
				args[1] === "--no-track" &&
				args[2] === "--" &&
				args[4] === "HEAD"
			) {
				if (args[3] !== taskBranchName(args[3].slice(5)))
					throw new Error("Invalid fixture branch");
			} else if (
				args.length === 8 &&
				args[0] === "worktree" &&
				args[1] === "add" &&
				args[2] === "--no-checkout" &&
				args[3] === "-b" &&
				args[5] === "--" &&
				args[7] === "HEAD"
			) {
				if (args[4] !== taskBranchName(args[4].slice(5)))
					throw new Error("Invalid fixture branch");
				virtualPath = args[6];
				if (!virtualPath.startsWith("/workspace/worktrees/"))
					throw new Error("Fixture worktree path denied");
				args[6] = hostPath(virtualPath);
			} else if (
				args.length === 4 &&
				args[0] === "worktree" &&
				args[1] === "remove" &&
				args[2] === "--" &&
				created.has(args[3])
			) {
				args[3] = hostPath(args[3]);
			} else throw new Error("Fixture refuses non-allowlisted Git operations");
			const result = run(
				args,
				repoPath,
				Math.min(command.timeoutMs, 10000),
				Math.min(command.maxOutputBytes, 65536),
			);
			if (virtualPath && result.exitCode === 0) created.add(virtualPath);
			if (args[0] === "rev-parse" && result.exitCode === 0) {
				const normalized = result.stdout
					.trim()
					.replaceAll(String.fromCharCode(92), "/");
				if (normalized !== repoPath.replaceAll(String.fromCharCode(92), "/"))
					throw new Error("Fixture root mismatch");
				return { ...result, stdout: "/workspace/repo\n" };
			}
			return result;
		},
		async destroy(handle) {
			if (handle.id !== sandbox.id) throw new Error("Unknown fixture handle");
			if (!closed) {
				rmSync(directory, { recursive: true, force: true });
				closed = true;
			}
		},
	};
	return { provider, sandbox, directory, repoPath, seed, hostPath };
}
