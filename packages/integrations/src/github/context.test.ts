import { describe, expect, test } from "bun:test";
import {
	type ContextBundle,
	contextBundleSchema,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import type {
	GitHubInstallationTokenRequest,
	GitHubTokenProvider,
} from "./auth";
import {
	fetchGitHubIncidentContext,
	GITHUB_CONTEXT_MAX_FETCH_CALLS,
	type GitHubContextDependencies,
} from "./context";

const REPOSITORY = "acme/widgets";
const TOKEN = "ghs_w13ctx_0123456789abcdef";
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const SHA_MAIN = "1111111111111111111111111111111111111111";
const SHA_RUN = "2222222222222222222222222222222222222222";

type FetchCall = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

const FILES: Record<string, string> = {
	".github/CODEOWNERS": "* @acme/core\n",
	".github/CONTRIBUTING.md": "# Contributing\n\nRun the tests.\n",
};

type RouterOptions = {
	repositoryStatus?: number;
	rulesetName?: string;
	codeownersBody?: string;
	oversizedRulesets?: boolean;
};

function router(options: RouterOptions = {}): {
	impl: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });
		if (url === "https://api.github.com/repos/acme/widgets") {
			if ((options.repositoryStatus ?? 200) !== 200) {
				return json(options.repositoryStatus ?? 200, { message: "nope" });
			}
			return json(200, {
				name: "widgets",
				full_name: REPOSITORY,
				default_branch: "main",
				html_url: "https://github.com/acme/widgets",
			});
		}
		if (url.includes("/actions/runs/2/jobs")) {
			return json(200, {
				jobs: [
					{
						id: 100,
						name: "build",
						status: "completed",
						conclusion: "failure",
						html_url: "https://github.com/acme/widgets/actions/runs/2/job/100",
						steps: [
							{ name: "install", conclusion: "success" },
							{ name: "test", conclusion: "failure" },
						],
					},
					{
						id: 101,
						name: "lint",
						status: "completed",
						conclusion: "success",
						html_url: "https://github.com/acme/widgets/actions/runs/2/job/101",
						steps: [],
					},
				],
			});
		}
		if (url.includes("/actions/runs?")) {
			return json(200, {
				workflow_runs: Array.from({ length: 6 }, (_, index) => ({
					id: index + 1,
					name: "CI",
					run_number: index + 1,
					run_attempt: 1,
					event: "push",
					status: "completed",
					conclusion: index === 1 ? "failure" : "success",
					head_branch: "main",
					head_sha: index === 1 ? SHA_RUN : SHA_MAIN,
					html_url: `https://github.com/acme/widgets/actions/runs/${index + 1}`,
				})),
			});
		}
		if (url.includes("/check-suites")) {
			return json(200, {
				check_suites: [
					{
						id: 99,
						status: "completed",
						conclusion: "failure",
						head_branch: "main",
						head_sha: SHA_RUN,
						html_url: "https://github.com/acme/widgets/runs/99",
						app: { slug: "github-actions", name: "GitHub Actions" },
					},
				],
			});
		}
		if (url.includes("/branches/main/protection")) {
			return json(200, {
				required_status_checks: { strict: true, contexts: ["ci"] },
				required_pull_request_reviews: {
					required_approving_review_count: 1,
					dismiss_stale_reviews: true,
				},
				enforce_admins: { enabled: false },
				allow_force_pushes: { enabled: false },
				required_conversation_resolution: { enabled: true },
			});
		}
		if (url.includes("/rulesets")) {
			if (options.oversizedRulesets === true) {
				return new Response("x".repeat(300 * 1024), { status: 200 });
			}
			return json(200, [
				{
					id: 1,
					name: options.rulesetName ?? "default",
					target: "branch",
					enforcement: "active",
				},
			]);
		}
		if (url.includes("/contents/")) {
			const path = decodeURIComponent(
				url.split("/contents/")[1]?.split("?")[0] ?? "",
			);
			const content =
				path === ".github/CODEOWNERS"
					? (options.codeownersBody ?? FILES[path])
					: FILES[path];
			if (content === undefined) return json(404, { message: "Not Found" });
			return json(200, {
				type: "file",
				path,
				size: content.length,
				encoding: "base64",
				content: Buffer.from(content, "utf8").toString("base64"),
				html_url: `https://github.com/acme/widgets/blob/main/${path}`,
			});
		}
		if (url.includes("/commits?")) {
			return json(200, [
				{
					sha: SHA_MAIN,
					commit: { message: "fix: handle incident\n\nbody" },
					author: { login: "octocat" },
				},
			]);
		}
		return json(404, { message: "Not Found" });
	};
	return { impl: impl as unknown as typeof fetch, calls };
}

function tokenProvider(overrides: Partial<{ token: string }> = {}): {
	requests: GitHubInstallationTokenRequest[];
	provider: GitHubTokenProvider;
} {
	const requests: GitHubInstallationTokenRequest[] = [];
	return {
		requests,
		provider: {
			async getInstallationToken(request) {
				requests.push(request);
				return {
					token: overrides.token ?? TOKEN,
					expiresAt: EXPIRES_AT,
				};
			},
		},
	};
}

function dependencies(
	impl: typeof fetch,
	provider: GitHubTokenProvider,
	overrides: Partial<GitHubContextDependencies> = {},
): GitHubContextDependencies {
	return {
		tokenProvider: provider,
		fetchImpl: impl,
		now: () => Date.parse("2026-10-31T00:00:00.000Z"),
		...overrides,
	};
}

function totalBytes(bundle: ContextBundle): number {
	return new TextEncoder().encode(
		bundle.items.map((item) => item.excerpt).join(""),
	).byteLength;
}

describe("fetchGitHubIncidentContext", () => {
	test("assembles a contract-valid bundle from a bounded query plan", async () => {
		const { impl, calls } = router();
		const tokens = tokenProvider();

		const bundle = await fetchGitHubIncidentContext(
			dependencies(impl, tokens.provider),
			{
				repositoryFullName: REPOSITORY,
				ref: "refs/heads/main",
				incidentFingerprint: "github:acme/widgets:CI:main",
			},
		);

		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.incidentFingerprint).toBe("github:acme/widgets:CI:main");
		expect(bundle.items.length).toBeLessThanOrEqual(20);
		expect(bundle.items.length).toBeGreaterThan(0);
		expect(totalBytes(bundle)).toBeLessThanOrEqual(
			MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		);
		for (const item of bundle.items) {
			expect(item.source).toBe("github");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.fetchedAt).toBe("2026-10-31T00:00:00.000Z");
			expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(item.url !== undefined || item.path !== undefined).toBe(true);
			expect(item.excerpt.length).toBeLessThanOrEqual(2000);
		}
		const kinds = bundle.items.map((item) => item.kind);
		expect(kinds.filter((kind) => kind === "workflow_run")).toHaveLength(5);
		expect(kinds).toContain("check_run");
		expect(kinds).toContain("check_suite");
		expect(kinds).toContain("branch_protection");
		expect(kinds).toContain("ruleset");
		expect(kinds).toContain("codeowners");
		expect(kinds).toContain("contributing");
		expect(kinds).toContain("commit");
		expect(kinds).not.toContain("pr_template");

		const codeowners = bundle.items.find((item) => item.kind === "codeowners");
		expect(codeowners?.path).toBe(".github/CODEOWNERS");
		expect(codeowners?.excerpt).toContain("@acme/core");

		const job = bundle.items.find((item) => item.kind === "check_run");
		expect(job?.excerpt).toContain("Failed steps: test");
		expect(JSON.stringify(job)).not.toContain("install (success)");

		expect(tokens.requests).toEqual([
			{
				repositoryFullName: REPOSITORY,
				contents: "read",
				actions: "read",
				checks: "read",
				pullRequests: "read",
				administration: "read",
			},
		]);
		expect(calls.length).toBeLessThanOrEqual(GITHUB_CONTEXT_MAX_FETCH_CALLS);
		for (const call of calls) {
			expect(
				(call.init.headers as Record<string, string> | undefined)
					?.Authorization,
			).toBe(`Bearer ${TOKEN}`);
		}
		expect(JSON.stringify(bundle)).not.toContain(TOKEN);
		expect(bundle.truncated).toBe(false);
	});

	test("enforces the 16 KiB / 20-item / 2,000-char caps", async () => {
		const huge = `owner-${"x".repeat(3000)}`;
		const { impl } = router({
			rulesetName: huge,
			codeownersBody: `* ${huge}\n`.repeat(100),
		});
		const tokens = tokenProvider();
		const bundle = await fetchGitHubIncidentContext(
			dependencies(impl, tokens.provider),
			{ repositoryFullName: REPOSITORY, ref: "main" },
		);
		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.items.length).toBeLessThanOrEqual(20);
		expect(totalBytes(bundle)).toBeLessThanOrEqual(
			MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		);
		for (const item of bundle.items) {
			expect(item.excerpt.length).toBeLessThanOrEqual(2000);
		}
		expect(bundle.truncated).toBe(true);
		expect(bundle.incidentFingerprint).toBe("github:acme/widgets:context:main");
	});

	test("honours a tighter item cap and reports truncation", async () => {
		const { impl } = router();
		const tokens = tokenProvider();
		const bundle = await fetchGitHubIncidentContext(
			dependencies(impl, tokens.provider, { maxItems: 2 }),
			{ repositoryFullName: REPOSITORY, ref: "main" },
		);
		expect(bundle.items).toHaveLength(2);
		expect(bundle.truncated).toBe(true);
	});

	test("maps 429 to RATE_LIMITED without echoing the token or URL", async () => {
		const impl = (async () =>
			json(
				429,
				{ message: `slow down ${TOKEN}` },
				{
					"retry-after": "60",
				},
			)) as unknown as typeof fetch;
		const tokens = tokenProvider();
		let error: unknown;
		try {
			await fetchGitHubIncidentContext(dependencies(impl, tokens.provider), {
				repositoryFullName: REPOSITORY,
			});
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(PlatformError);
		expect((error as PlatformError).code).toBe("RATE_LIMITED");
		expect(String((error as Error).message)).not.toContain(TOKEN);
	});

	test("maps a 403 on repository metadata to POLICY_DENIED", async () => {
		const { impl } = router({ repositoryStatus: 403 });
		const tokens = tokenProvider();
		let error: unknown;
		try {
			await fetchGitHubIncidentContext(dependencies(impl, tokens.provider), {
				repositoryFullName: REPOSITORY,
			});
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(PlatformError);
		expect((error as PlatformError).code).toBe("POLICY_DENIED");
	});

	test("maps token failures to a bounded error", async () => {
		const { impl } = router();
		const provider: GitHubTokenProvider = {
			async getInstallationToken() {
				throw new PlatformError("POLICY_DENIED", "no scope");
			},
		};
		let error: unknown;
		try {
			await fetchGitHubIncidentContext(dependencies(impl, provider), {
				repositoryFullName: REPOSITORY,
			});
		} catch (thrown) {
			error = thrown;
		}
		expect((error as PlatformError).code).toBe("POLICY_DENIED");
		expect(String((error as Error).message)).not.toContain("no scope");
	});

	test("rejects invalid repository and ref inputs before minting a token", async () => {
		const { impl, calls } = router();
		const tokens = tokenProvider();
		for (const input of [
			{ repositoryFullName: "not-a-repo" },
			{ repositoryFullName: REPOSITORY, ref: "bad ref" },
			{ repositoryFullName: REPOSITORY, ref: "x".repeat(201) },
		]) {
			let error: unknown;
			try {
				await fetchGitHubIncidentContext(
					dependencies(impl, tokens.provider),
					input,
				);
			} catch (thrown) {
				error = thrown;
			}
			expect((error as PlatformError).code).toBe("VALIDATION_FAILED");
		}
		expect(tokens.requests).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	test("keeps a partial bundle when the repository metadata is missing", async () => {
		const { impl } = router({ repositoryStatus: 404 });
		const tokens = tokenProvider();
		const bundle = await fetchGitHubIncidentContext(
			dependencies(impl, tokens.provider),
			{ repositoryFullName: REPOSITORY },
		);
		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.truncated).toBe(true);
	});

	test("drops an oversized provider response and marks the bundle truncated", async () => {
		const { impl } = router({ oversizedRulesets: true });
		const tokens = tokenProvider();
		const bundle = await fetchGitHubIncidentContext(
			dependencies(impl, tokens.provider),
			{ repositoryFullName: REPOSITORY, ref: "main" },
		);
		expect(bundle.items.map((item) => item.kind)).not.toContain("ruleset");
		expect(bundle.truncated).toBe(true);
		expect(totalBytes(bundle)).toBeLessThanOrEqual(
			MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		);
	});
});
