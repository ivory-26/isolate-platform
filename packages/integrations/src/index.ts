/**
 * Barrel for the integrations package (github + mcp surfaces). All public
 * contracts are exported here; credentials always stay server-side.
 */

export * from "./github/auth";
export * from "./github/context";
export * from "./github/incidents";
export * from "./github/pull-requests";
export * from "./github/redact";
export * from "./github/rest-client";
export * from "./github/schemas";
export * from "./github/types";
export * from "./github/webhook";
export * from "./github/writes";
export * from "./mcp/guard";
