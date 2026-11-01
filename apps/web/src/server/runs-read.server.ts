import "@tanstack/react-start/server-only";

/**
 * Server-only import point for the Runs read model.
 *
 * Keeping the database-backed reads behind this module means the server
 * functions never import `@isolate/db` directly, and the read model can be
 * exercised with a scripted `PgSql` in tests without a live database.
 */
export { readRunDetail, readRunsList } from "../features/runs/read-model";
