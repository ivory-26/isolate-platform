/**
 * Barrel for the integrations package (github + mcp surfaces). All public
 * contracts are exported here; credentials always stay server-side.
 */

export * from "./github/auth";
export * from "./github/redact";
export * from "./github/rest-client";
export * from "./github/schemas";
export * from "./github/types";
export * from "./mcp/guard";
