import { strict as assert } from "node:assert";
import {
	createDb,
	PostgresArtifactRepository,
	PostgresBlobStore,
	PostgresExecutionLifecycle,
	PostgresTaskContextRepository,
	PostgresTaskRepository,
	type JobRow,
} from "../packages/db/src/index";
import type { CodingAgentRuntimeFactory } from "../packages/mastra/src/agents/types";
import { wireSandboxTools } from "../packages/mastra/src/tools/sandbox-tools";
import { createTaskWorkspaceGit } from "../packages/sandbox/src/index";
import type { UsageSink } from "../packages/shared/src/index";
import {
	asJobId,
	asOrganizationId,
	asTaskId,
	createConsoleLogger,
} from "../packages/shared/src/index";
import {
	createTaskExecutionHandler,
	type TaskExecutionDeps,
} from "../apps/worker/src/task-execution-handler";
import {
	createSandboxToolBackend,
	createWorkspaceToolPolicy,
} from "../apps/worker/src/sandbox-tool-backend";
import { createTaskContextLoader } from "../apps/worker/src/task-context";
import {
	createSandboxEnvResolver,
	selectGitHubTokenProvider,
	selectSandboxProvider,
} from "../apps/worker/src/runtime-composition";

/**
 * Wave 11 live blob proof (ONE bounded sandbox, ZERO inference calls).
 *
 * A deterministic runtime writes two 200 KB files, commits, and the handler's
 * diff gate produces a patch above the 256 KiB inline cap. The artifact must
 * carry a `blob:<sha256>` reference with a bounded inline preview, and the
 * full bytes must be readable through PostgresBlobStore.
 */

if (process.env.LIVE_BLOB !== "1") {
	console.log("Set LIVE_BLOB=1 to run the bounded blob acceptance.");
	process.exit(0);
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		console.error(`${name} is required for this acceptance run`);
		process.exit(1);
	}
	return value;
}

const organizationId = asOrganizationId(required("LIVE_ORGANIZATION_ID"));
const userId = required("LIVE_USER_ID");
const repositoryId = required("LIVE_REPOSITORY_ID");
const databaseUrl = required("DATABASE_URL");
const branch = `task/w11-blob-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
const FILES = ["live-blob-1.txt", "live-blob-2.txt"] as const;
const CHUNK = `${"a".repeat(200_000)}\n`;

const logger = createConsoleLogger("live-blob");

const sql = createDb(databaseUrl);
const tasks = new PostgresTaskRepository(sql);
const artifacts = new PostgresArtifactRepository(sql);
const blobs = new PostgresBlobStore(sql);

try {
	const sandbox = await selectSandboxProvider({
		...process.env,
		SANDBOX_PROVIDER: "modal",
	});
	assert.ok(sandbox.real, "Modal provider is not configured");
	const broker = selectGitHubTokenProvider(process.env);
	assert.ok(broker, "GitHub broker is not configured");

	const usageSink: UsageSink = { async record() {} };
	const createRuntime: CodingAgentRuntimeFactory = (options) => {
		const backend = options.sandboxBackend;
		const context = options.toolContext;
		if (!backend || !context) throw new Error("tool backend missing");
		const tools = wireSandboxTools(backend).forTask({
			organizationId: context.organizationId,
			taskId: context.taskId,
			scopes: [...(context.scopes ?? [])],
			fileOwnership: [...(context.fileOwnership ?? [])],
		});
		let used = false;
		return {
			async runTurn() {
				if (used) return "";
				used = true;
				for (const [index, file] of FILES.entries()) {
					const write = await tools["repo.write_file"].execute?.(
						{ path: file, content: `${CHUNK}file ${index + 1}\n` },
						{} as never,
					);
					if (write?.state !== "executed") {
						throw new Error(`write failed: ${write?.state ?? "none"}`);
					}
				}
				const commit = await tools["git.commit_local"].execute?.(
					{ message: "chore: wave 11 blob acceptance" },
					{} as never,
				);
				if (commit?.state !== "executed") {
					throw new Error(`commit failed: ${commit?.state ?? "none"}`);
				}
				return "";
			},
		};
	};

	const workspaceRoot = "/tmp";
	const deps: TaskExecutionDeps = {
		provider: sandbox.provider,
		createRuntime,
		createSandboxBackend: ({ sandbox: handle, signal, baseBranch, repoPath }) =>
			createSandboxToolBackend({
				provider: sandbox.provider,
				sandbox: handle,
				signal,
				policy: createWorkspaceToolPolicy(handle.workspaceRoot),
				...(baseBranch === undefined ? {} : { baseBranch }),
				...(repoPath === undefined ? {} : { repoPath }),
			}),
		usageSink,
		loadTaskContext: createTaskContextLoader(
			new PostgresTaskContextRepository(sql),
		),
		lifecycle: new PostgresExecutionLifecycle(sql),
		createWorkspaceGit: createTaskWorkspaceGit,
		resolveSandboxEnv: createSandboxEnvResolver(broker),
		blobStore: blobs,
		pushEnabled: false,
		caps: { maxOutputTokensPerTurn: 16, maxTaskTokens: 1_000, maxSteps: 1 },
		sandboxPolicy: createWorkspaceToolPolicy(workspaceRoot),
		sandbox: {
			cpuCount: 0.125,
			memoryMb: 512,
			lifetimeMs: 240_000,
			idleTimeoutMs: 60_000,
		},
		maxSandboxSeconds: 240,
		maxCostUsdPerTask: 1,
		priceTable: null,
	};

	const task = await tasks.create({
		organizationId,
		repositoryId,
		branch,
		idempotencyKey: `live-blob:${crypto.randomUUID()}`,
		budgetLimits: {
			maxAgentTurns: 1,
			maxRepairAttempts: 0,
			maxDurationMs: 240_000,
		},
		goal: "Write two large fixture files and commit them.",
		acceptanceCriteria: ["both fixture files exist on the branch"],
		fileOwnership: [...FILES],
		createdBy: userId,
	});
	const taskId = asTaskId(task.id);
	console.log(`task: ${taskId} branch: ${branch}`);

	const job: JobRow = {
		id: asJobId(crypto.randomUUID()),
		organizationId,
		taskId,
		type: "run_task",
		payload: { taskId },
		status: "claimed",
		attempts: 1,
		maxAttempts: 1,
		lease: {
			ownerId: "live-blob-acceptance",
			leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		notBefore: new Date().toISOString(),
		enqueueUuidKey: `run_task:${taskId}`,
		lastError: null,
		createdAt: new Date().toISOString(),
	};
	const verdict = await createTaskExecutionHandler(deps).handle(job, {
		logger,
		signal: new AbortController().signal,
		heartbeat: async () => true,
	});
	console.log(`run_task: ${verdict.outcome}${verdict.note ? ` (${verdict.note})` : ""}`);
	assert.equal(verdict.outcome, "complete");

	const finalTask = await tasks.get(taskId);
	assert.equal(finalTask?.status, "review_ready", "task did not reach review_ready");

	const rows = await artifacts.listByTask({ organizationId, taskId });
	const diff = rows.find((row) => row.kind === "diff");
	assert.ok(diff, "diff artifact missing");
	assert.match(diff.storage_ref, /^blob:[0-9a-f]{64}$/, "diff is not blob-backed");
	assert.ok(
		diff.byte_size > 262_144,
		`expected a patch above the inline cap, got ${diff.byte_size} bytes`,
	);
	assert.ok(
		Buffer.byteLength(diff.content ?? "", "utf8") <= 262_144,
		"inline preview exceeds the column cap",
	);

	const stored = await blobs.get({
		organizationId,
		storageRef: diff.storage_ref,
	});
	assert.ok(stored, "blob bytes are not readable");
	assert.equal(stored.bytes.byteLength, diff.byte_size);
	assert.equal(stored.sha256, diff.sha256);
	const digest = new Bun.CryptoHasher("sha256")
		.update(stored.bytes)
		.digest("hex");
	assert.equal(digest, diff.sha256, "blob content does not match the artifact sha");

	console.log(
		JSON.stringify(
			{
				taskId,
				branch,
				status: finalTask.status,
				artifact: {
					storageRef: diff.storage_ref,
					byteSize: diff.byte_size,
					previewBytes: Buffer.byteLength(diff.content ?? "", "utf8"),
					sha256: diff.sha256,
				},
				blobBytes: stored.bytes.byteLength,
			},
			null,
			2,
		),
	);
	console.log("LIVE BLOB ACCEPTANCE PASSED (large diff stored, preview bounded)");
} catch (error) {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: "INTERNAL";
	const message =
		error instanceof Error ? error.message.slice(0, 300) : "unknown failure";
	console.error(`LIVE BLOB ACCEPTANCE FAILED: ${code}: ${message}`);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 });
}
