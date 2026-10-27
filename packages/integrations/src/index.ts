import { PlatformError } from "@isolate/shared";

/**
 * GitHub connector contracts (architecture §3/§7). Sprint B-4 implements
 * against the installed SDK/REST surface; credentials are resolved server-side
 * through a scoped broker and never logged, never sent to the model.
 */
export type PullRequestSpec = {
	repositoryFullName: string; // "org/repo"
	headBranch: string;
	baseBranch: string;
	title: string;
	body: string;
	// Set only when an approval decision exists for this exact payload.
	approvalId?: string;
	approvalPayloadSha256?: string;
};

export type PullRequestInfo = {
	number: number;
	url: string;
	headBranch: string;
};

export interface PullRequestCreator {
	createPullRequest(spec: PullRequestSpec): Promise<
		| { ok: true; pr: PullRequestInfo }
		| {
				ok: false;
				code:
					| "VALIDATION_FAILED"
					| "APPROVAL_REQUIRED"
					| "INTEGRATION_UNAVAILABLE"
					| "POLICY_DENIED";
		  }
	>;
}

export type GitHubCredentials = {
	// Scoped, short-lived app installation token; never a PAT in platform code.
	installationToken: string;
	passwordless: true;
};

/**
 * Stub implementation — Sprint B-4 replaces it with real REST calls including
 * webhook verification, rate-limit budgeting, and redacted error mapping.
 */
export function createPrCreatorNotImplemented(): PullRequestCreator {
	return {
		createPullRequest: async (_spec: PullRequestSpec) => ({
			ok: false as const,
			code: "INTEGRATION_UNAVAILABLE" as const,
		}),
	};
}

/**
 * MCP registry guard (§7): unknown servers are denied by default; per-tool
 * permissions and audit are enforced in trusted code, not model instructions.
 */
export type McpServerDescriptor = {
	id: string;
	trustLevel: "allowlisted" | "pending_review" | "blocked";
};

export function isAllowedServer(
	servers: readonly McpServerDescriptor[],
	id: string,
): boolean {
	const found = servers.find((s) => s.id === id);
	return found?.trustLevel === "allowlisted";
}

export function serverNotAllowlisted(id: string): PlatformError {
	return new PlatformError(
		"POLICY_DENIED",
		`mcp server not allowlisted: ${id}`,
	);
}
