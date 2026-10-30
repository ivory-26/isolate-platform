import { describe, expect, test } from "bun:test";
import {
	githubIncidentFingerprint,
	githubIncidentSeverity,
	isGitHubProductionBranchName,
	normalizeGitHubIncident,
	normalizeGitHubRef,
} from "./incidents";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const RECEIVED_AT = "2026-10-31T00:00:00.000Z";
const DELIVERY = { id: "delivery-1", receivedAt: RECEIVED_AT };

const repository = {
	name: "widgets",
	full_name: "acme/widgets",
	default_branch: "main",
	html_url: "https://github.com/acme/widgets",
	owner: { login: "acme" },
};

function workflowEvent(run: Record<string, unknown> = {}, repo = repository) {
	return {
		name: "workflow_run",
		payload: {
			action: "completed",
			repository: repo,
			workflow_run: {
				id: 42,
				name: "CI",
				head_branch: "main",
				head_sha: SHA,
				run_number: 7,
				run_attempt: 1,
				event: "push",
				status: "completed",
				conclusion: "failure",
				html_url: "https://github.com/acme/widgets/actions/runs/42",
				...run,
			},
		},
	};
}

function checkSuiteEvent(
	suite: Record<string, unknown> = {},
	repo = repository,
	action = "completed",
) {
	return {
		name: "check_suite",
		payload: {
			action,
			repository: repo,
			check_suite: {
				id: 99,
				head_branch: "main",
				head_sha: SHA,
				status: "completed",
				conclusion: "failure",
				html_url: "https://github.com/acme/widgets/runs/99",
				app: { slug: "github-actions", name: "GitHub Actions" },
				...suite,
			},
		},
	};
}

describe("githubIncidentSeverity", () => {
	test("is high on a non-default branch", () => {
		expect(
			githubIncidentSeverity({ defaultBranch: "main", ref: "feature/x" }),
		).toBe("high");
	});

	test("is critical when the default branch is production-like and matches the ref", () => {
		expect(githubIncidentSeverity({ defaultBranch: "main", ref: "main" })).toBe(
			"critical",
		);
		expect(
			githubIncidentSeverity({
				defaultBranch: "main",
				ref: "refs/heads/main",
			}),
		).toBe("critical");
		expect(
			githubIncidentSeverity({
				defaultBranch: "prod",
				ref: "refs/heads/prod",
			}),
		).toBe("critical");
	});

	test("is high when the ref is production-like but not the default branch", () => {
		expect(
			githubIncidentSeverity({ defaultBranch: "develop", ref: "main" }),
		).toBe("high");
		expect(
			githubIncidentSeverity({ defaultBranch: "release", ref: "master" }),
		).toBe("high");
	});

	test("is high when the default branch is not production-like", () => {
		expect(
			githubIncidentSeverity({ defaultBranch: "develop", ref: "develop" }),
		).toBe("high");
	});

	test("is critical when the payload names a production environment", () => {
		expect(
			githubIncidentSeverity({
				defaultBranch: "develop",
				ref: "feature/x",
				environment: "Production",
			}),
		).toBe("critical");
	});

	test("stays critical on the default branch regardless of environment, and is high for an unknown default branch", () => {
		expect(githubIncidentSeverity({ defaultBranch: null, ref: "main" })).toBe(
			"high",
		);
		expect(
			githubIncidentSeverity({
				defaultBranch: "main",
				ref: "main",
				environment: "staging",
			}),
		).toBe("critical");
		expect(isGitHubProductionBranchName("main")).toBe(true);
		expect(isGitHubProductionBranchName("feature/main")).toBe(false);
		expect(normalizeGitHubRef("refs/heads/main")).toBe("main");
	});
});

describe("githubIncidentFingerprint", () => {
	test("is the documented, stable shape", () => {
		expect(
			githubIncidentFingerprint({
				repositoryFullName: "acme/widgets",
				name: "CI",
				headBranch: "main",
			}),
		).toBe("github:acme/widgets:CI:main");
	});

	test("is bounded and deterministic for long components", () => {
		const input = {
			repositoryFullName: "acme/widgets",
			name: `CI ${"n".repeat(200)}`,
			headBranch: "release/very-long-branch-name".repeat(5),
		};
		const first = githubIncidentFingerprint(input);
		expect(first).toBe(githubIncidentFingerprint(input));
		expect(first.length).toBeLessThanOrEqual(128);
		expect(first.startsWith("github:acme/widgets:")).toBe(true);
	});

	test("separates different workflows and branches", () => {
		const base = {
			repositoryFullName: "acme/widgets",
			name: "CI",
			headBranch: "main",
		};
		expect(githubIncidentFingerprint(base)).not.toBe(
			githubIncidentFingerprint({
				...base,
				name: "Deploy",
			}),
		);
		expect(githubIncidentFingerprint(base)).not.toBe(
			githubIncidentFingerprint({
				...base,
				headBranch: "feature/x",
			}),
		);
	});
});

describe("normalizeGitHubIncident — workflow_run", () => {
	test("produces a critical signal on the default branch", () => {
		const signal = normalizeGitHubIncident(workflowEvent(), DELIVERY);
		expect(signal).not.toBeNull();
		if (signal === null) return;
		expect(signal.source).toBe("github");
		expect(signal.kind).toBe("workflow_failed");
		expect(signal.severity).toBe("critical");
		expect(signal.service).toBe("widgets");
		expect(signal.fingerprint).toBe("github:acme/widgets:CI:main");
		expect(signal.receivedAt).toBe(RECEIVED_AT);
		expect(signal.links.map((link) => link.url)).toContain(
			"https://github.com/acme/widgets/actions/runs/42",
		);
		expect(signal.summary).toContain("Conclusion: failure");
		expect(signal.summary).toContain("\n");
	});

	test("is high on a feature branch", () => {
		const signal = normalizeGitHubIncident(
			workflowEvent({ head_branch: "feature/x" }),
			DELIVERY,
		);
		expect(signal?.severity).toBe("high");
	});

	test("accepts timed_out and cancelled conclusions", () => {
		for (const conclusion of ["timed_out", "cancelled"]) {
			const signal = normalizeGitHubIncident(
				workflowEvent({ conclusion }),
				DELIVERY,
			);
			expect(signal).not.toBeNull();
			expect(signal?.summary).toContain(`Conclusion: ${conclusion}`);
		}
	});

	test("is critical for a production environment on any branch", () => {
		const signal = normalizeGitHubIncident(
			workflowEvent({
				head_branch: "feature/x",
				environment: { name: "production" },
			}),
			DELIVERY,
		);
		expect(signal?.severity).toBe("critical");
	});

	test("is critical when the payload names a production deployment environment", () => {
		const event = workflowEvent({ head_branch: "feature/x" });
		(
			event.payload as { deployment_environment?: string }
		).deployment_environment = "production";
		expect(normalizeGitHubIncident(event, DELIVERY)?.severity).toBe("critical");
	});

	test("ignores non-completed actions and non-triggering conclusions", () => {
		const requested = workflowEvent();
		(requested.payload as { action: string }).action = "requested";
		expect(normalizeGitHubIncident(requested, DELIVERY)).toBeNull();
		expect(
			normalizeGitHubIncident(
				workflowEvent({ conclusion: "success" }),
				DELIVERY,
			),
		).toBeNull();
		expect(
			normalizeGitHubIncident(workflowEvent({ conclusion: null }), DELIVERY),
		).toBeNull();
	});

	test("fingerprint is stable across re-deliveries", () => {
		const first = normalizeGitHubIncident(workflowEvent(), {
			id: "delivery-1",
			receivedAt: RECEIVED_AT,
		});
		const second = normalizeGitHubIncident(workflowEvent(), {
			id: "delivery-2",
			receivedAt: "2026-10-31T00:05:00.000Z",
		});
		expect(first?.fingerprint).toBe(second?.fingerprint);
		expect(first?.summary).not.toBe(second?.summary);
	});

	test("redacts credential-shaped provider names and never carries logs", () => {
		const signal = normalizeGitHubIncident(
			workflowEvent({ name: "deploy ghp_abcdefgh12345678" }),
			DELIVERY,
		);
		expect(signal).not.toBeNull();
		const serialized = JSON.stringify(signal);
		expect(serialized).not.toContain("ghp_abcdefgh12345678");
	});

	test("rejects malformed payloads and unsupported events", () => {
		expect(
			normalizeGitHubIncident(
				{ name: "workflow_run", payload: { action: "completed" } },
				DELIVERY,
			),
		).toBeNull();
		expect(
			normalizeGitHubIncident(
				{ name: "issues", payload: { action: "opened" } },
				DELIVERY,
			),
		).toBeNull();
	});
});

describe("normalizeGitHubIncident — check_suite", () => {
	test("produces a check_failed signal", () => {
		const signal = normalizeGitHubIncident(checkSuiteEvent(), DELIVERY);
		expect(signal).not.toBeNull();
		expect(signal?.kind).toBe("check_failed");
		expect(signal?.severity).toBe("critical");
		expect(signal?.fingerprint).toBe("github:acme/widgets:github-actions:main");
		expect(signal?.links[0]?.url).toBe(
			"https://github.com/acme/widgets/runs/99",
		);
	});

	test("is high for a non-default branch", () => {
		const signal = normalizeGitHubIncident(
			checkSuiteEvent({ head_branch: "feature/x" }),
			DELIVERY,
		);
		expect(signal?.severity).toBe("high");
	});

	test("ignores non-failure and non-completed suites", () => {
		expect(
			normalizeGitHubIncident(
				checkSuiteEvent({ conclusion: "neutral" }),
				DELIVERY,
			),
		).toBeNull();
		expect(
			normalizeGitHubIncident(
				checkSuiteEvent({}, repository, "requested"),
				DELIVERY,
			),
		).toBeNull();
	});
});
