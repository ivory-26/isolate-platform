import { PlatformError } from "@isolate/shared";

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
