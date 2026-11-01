import "@tanstack/react-start/server-only";
import {
	createDb,
	hasCapability,
	type PgSql,
	type PlatformCapability,
} from "@isolate/db";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
	type UiError,
	type UiFailureCode,
	UiInvalidInputError,
	UiNotFoundError,
	type UiResult,
} from "../features/ui/contracts";
import { resolveTrustedScope } from "./runtime.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

/**
 * Shared seam for tenant-scoped UI read models.
 *
 * Every read:
 * - resolves the caller's tenant and role on the server;
 * - checks the capability BEFORE touching storage;
 * - binds `scope.organizationId` as the only tenancy input;
 * - answers with `private, no-store`.
 */
const FIXED_MESSAGES: Record<UiFailureCode, string> = {
	AUTH_REQUIRED: "Sign in to continue.",
	FORBIDDEN: "This data is not available in your role for this organization.",
	INVALID_INPUT: "The request is invalid.",
	NOT_FOUND: "The requested record was not found.",
	UNAVAILABLE: "Live control-plane data is unavailable.",
};

let sql: PgSql | undefined;
let sqlUrl: string | undefined;

export function getUiSql(): PgSql {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new ControlPlaneError(
			"UNAVAILABLE",
			undefined,
			"Live data is not configured in this environment.",
		);
	}
	if (sql === undefined || sqlUrl !== databaseUrl) {
		sql = createDb(databaseUrl);
		sqlUrl = databaseUrl;
	}
	return sql;
}

export function setNoStore(): void {
	setResponseHeader("Cache-Control", "private, no-store");
}

export async function requireUiScope(
	capability: PlatformCapability = "task:read",
): Promise<CallerScope> {
	const scope = await resolveTrustedScope();
	if (!hasCapability(scope.role, capability)) {
		throw new ControlPlaneError("FORBIDDEN");
	}
	return scope;
}

function failure(error: unknown): UiError {
	if (error instanceof UiNotFoundError) {
		return { code: "NOT_FOUND", message: FIXED_MESSAGES.NOT_FOUND };
	}
	if (error instanceof UiInvalidInputError) {
		return { code: "INVALID_INPUT", message: FIXED_MESSAGES.INVALID_INPUT };
	}
	if (error instanceof ControlPlaneError) {
		const code = error.code === "CONFLICT" ? "UNAVAILABLE" : error.code;
		if (code === "WORKFLOW_REJECTED") {
			return { code: "UNAVAILABLE", message: FIXED_MESSAGES.UNAVAILABLE };
		}
		return {
			code,
			message: error.message.slice(0, 240) || FIXED_MESSAGES[code],
		};
	}
	return { code: "UNAVAILABLE", message: FIXED_MESSAGES.UNAVAILABLE };
}

export async function uiRead<T>(
	capability: PlatformCapability,
	read: (scope: CallerScope, sql: PgSql) => Promise<T>,
): Promise<UiResult<T>> {
	setNoStore();
	try {
		const scope = await requireUiScope(capability);
		return { ok: true, value: await read(scope, getUiSql()) };
	} catch (error) {
		return { ok: false, error: failure(error) };
	}
}

export function iso(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return new Date(value).toISOString();
	throw new Error("Invalid stored timestamp");
}

export function isoOrNull(value: unknown): string | null {
	return value === null || value === undefined ? null : iso(value);
}

export function numeric(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}
