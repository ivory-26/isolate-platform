import "@tanstack/react-start/server-only";
import {
	createDb,
	hasCapability,
	MAX_BLOB_BYTES,
	type PgSql,
	type PlatformCapability,
	PostgresBlobStore,
	parseBlobStorageRef,
	type UserRole,
} from "@isolate/db";
import { PlatformError } from "@isolate/shared";
import { readActiveOrganizationPreference } from "./active-organization.server";
import { type AuthRuntime, createAuthRuntime } from "./auth-runtime.server";
import { resolveCallerScope } from "./caller-scope.server";
import { readNeonAuthSettings } from "./neon-auth.server";
import { assertSameOrigin, RequestGuardError } from "./request-guard.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

/**
 * Bounded artifact payload read: `GET /api/artifacts/{artifactId}`.
 *
 * Serves only bytes that already live in the tenant-scoped blob store. The
 * artifact id is validated as a UUID and the storage reference must be exactly
 * `blob:<sha256>`, so the path can never traverse the filesystem or address an
 * arbitrary object. Authorization reuses the same trusted session scope as
 * every other read: `task:read` is checked before storage, the caller's
 * organization is the only tenancy input, and a foreign or missing artifact is
 * one fixed 404.
 *
 * The response is capped at the blob store's 2 MiB write ceiling, forces a
 * download (`Content-Disposition: attachment`), sets `nosniff`, and never
 * reflects a stored content type that is not a plain `type/subtype`.
 */

const ARTIFACT_UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTENT_TYPE_PATTERN =
	/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,63}$/;

const KIND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

const EXTENSIONS: Readonly<Record<string, string>> = {
	"text/x-diff": ".diff",
	"text/plain": ".log",
	"text/markdown": ".md",
	"application/json": ".json",
	"text/csv": ".csv",
};

const ROLES: ReadonlySet<UserRole> = new Set([
	"owner",
	"admin",
	"member",
	"viewer",
]);

export type ArtifactPayloadView = {
	artifactId: string;
	bytes: Uint8Array;
	contentType: string;
	kind: string;
};

export type ArtifactPayloadInput = {
	organizationId: string;
	artifactId: string;
};

export interface ArtifactPayloadRepository {
	/** `null` when the artifact is absent, foreign, or has no stored blob. */
	getArtifactPayload(
		input: ArtifactPayloadInput,
	): Promise<ArtifactPayloadView | null>;
}

export function normalizeArtifactId(value: unknown): string | null {
	if (typeof value !== "string" || !ARTIFACT_UUID_PATTERN.test(value)) {
		return null;
	}
	return value.toLowerCase();
}

/** `GET /api/artifacts/{artifactId}` — the id is the last path segment. */
export function readArtifactId(request: Request): string | null {
	let segments: string[];
	try {
		segments = new URL(request.url).pathname.split("/").filter(Boolean);
	} catch {
		return null;
	}
	const index = segments.lastIndexOf("artifacts");
	if (index < 0 || index + 2 !== segments.length) return null;
	return normalizeArtifactId(segments[index + 1]);
}

function requireScope(
	scope: CallerScope,
	capability: PlatformCapability,
): CallerScope {
	if (!ROLES.has(scope.role) || !hasCapability(scope.role, capability)) {
		throw new ControlPlaneError("FORBIDDEN");
	}
	return scope;
}

export type ArtifactReadDependencies = {
	/** Trusted server-side caller identity; never request data. */
	resolveScope: () => Promise<CallerScope>;
	artifacts: ArtifactPayloadRepository;
};

export type ArtifactReadService = {
	getArtifactPayload(
		scope: CallerScope,
		input: unknown,
	): Promise<ArtifactPayloadView>;
};

export function createArtifactReadService(
	dependencies: ArtifactReadDependencies,
): ArtifactReadService {
	return {
		async getArtifactPayload(scope, input) {
			const candidate =
				typeof input === "object" && input !== null
					? (input as { artifactId?: unknown }).artifactId
					: undefined;
			const artifactId = normalizeArtifactId(candidate);
			if (artifactId === null) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"artifact request is invalid",
				);
			}
			// Capability before storage: a denied caller touches no row.
			requireScope(scope, "task:read");
			const payload = await dependencies.artifacts.getArtifactPayload({
				organizationId: scope.organizationId,
				artifactId,
			});
			if (payload === null) {
				throw new PlatformError("NOT_FOUND", "artifact not found");
			}
			return payload;
		},
	};
}

/** Only a bare `type/subtype` is reflected; anything else is opaque bytes. */
export function safeArtifactContentType(value: string | null): string {
	if (typeof value !== "string") return "application/octet-stream";
	const trimmed = value.trim();
	return CONTENT_TYPE_PATTERN.test(trimmed)
		? trimmed.toLowerCase()
		: "application/octet-stream";
}

/** A generated filename built from bounded kind/id fields, never stored text. */
export function artifactDownloadName(
	artifactId: string,
	kind: string,
	contentType: string,
): string {
	const safeKind = KIND_PATTERN.test(kind) ? kind : "artifact";
	const extension = EXTENSIONS[contentType] ?? ".bin";
	return `${safeKind}-${artifactId.slice(0, 8)}${extension}`;
}

function payloadResponse(payload: ArtifactPayloadView): Response {
	const contentType = safeArtifactContentType(payload.contentType);
	// A fresh copy keeps the response body's backing buffer unambiguous.
	return new Response(new Uint8Array(payload.bytes), {
		status: 200,
		headers: {
			"cache-control": "private, no-store",
			pragma: "no-cache",
			"content-type": contentType,
			"content-length": String(payload.bytes.byteLength),
			"content-disposition": `attachment; filename="${artifactDownloadName(
				payload.artifactId,
				payload.kind,
				contentType,
			)}"`,
			"x-content-type-options": "nosniff",
		},
	});
}

function json(status: number, body: unknown): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store", pragma: "no-cache" },
	});
}

function fixedError(status: number, error: string): Response {
	return json(status, { error });
}

function unavailable(): Response {
	return fixedError(503, "artifact read is unavailable");
}

/** Maps a service failure to fixed text; never serializes the thrown value. */
function failureResponse(error: unknown): Response {
	if (error instanceof RequestGuardError) {
		return fixedError(error.status, "request rejected");
	}
	if (error instanceof ControlPlaneError) {
		if (error.code === "AUTH_REQUIRED") {
			return fixedError(401, "authentication required");
		}
		if (error.code === "FORBIDDEN") return fixedError(403, "forbidden");
	}
	if (error instanceof PlatformError) {
		switch (error.code) {
			case "VALIDATION_FAILED":
				return fixedError(400, "artifact request is invalid");
			case "NOT_FOUND":
				return fixedError(404, "artifact not found");
			default:
				break;
		}
	}
	return unavailable();
}

const STMT = {
	artifact: `SELECT a.kind, a.content_type, a.storage_ref
		FROM artifacts a
		WHERE a.organization_id = $1 AND a.id = $2
		LIMIT 1`,
} as const;

export class PostgresArtifactPayloadRepository
	implements ArtifactPayloadRepository
{
	private readonly blobs: PostgresBlobStore;

	constructor(private readonly sql: PgSql) {
		this.blobs = new PostgresBlobStore(sql);
	}

	async getArtifactPayload(
		input: ArtifactPayloadInput,
	): Promise<ArtifactPayloadView | null> {
		const rows = (await this.sql.unsafe(STMT.artifact, [
			input.organizationId,
			input.artifactId,
		])) as unknown as Record<string, unknown>[];
		const row = rows[0];
		if (row === undefined) return null;
		// Only a persisted blob ref is served; inline-only artifacts keep their
		// bounded preview and have no separate payload to download.
		const storageRef =
			typeof row.storage_ref === "string" ? row.storage_ref : "";
		if (parseBlobStorageRef(storageRef) === null) return null;

		const stored = await this.blobs.get({
			organizationId: input.organizationId,
			storageRef,
		});
		if (stored === null) return null;
		// The store enforces this on write; keep the response bounded anyway.
		if (stored.bytes.byteLength > MAX_BLOB_BYTES) return null;

		const contentType =
			typeof row.content_type === "string" && row.content_type.length > 0
				? row.content_type
				: stored.contentType;
		return {
			artifactId: input.artifactId,
			bytes: stored.bytes,
			contentType,
			kind: typeof row.kind === "string" ? row.kind : "artifact",
		};
	}
}

export type ArtifactReadRoutes = {
	get(request: Request): Promise<Response>;
};

/** Route adapter over the pure service; every response is no-store. */
export function createArtifactReadRoutes(
	dependencies: ArtifactReadDependencies,
): ArtifactReadRoutes {
	const service = createArtifactReadService(dependencies);

	return {
		async get(request) {
			if (request.method !== "GET") {
				return fixedError(405, "method not allowed");
			}
			try {
				assertSameOrigin(request);
			} catch (error) {
				return failureResponse(error);
			}
			// The path is validated before a session lookup or a query.
			const artifactId = readArtifactId(request);
			if (artifactId === null) {
				return fixedError(400, "artifact request is invalid");
			}
			try {
				const scope = await dependencies.resolveScope();
				const payload = await service.getArtifactPayload(scope, {
					artifactId,
				});
				return payloadResponse(payload);
			} catch (error) {
				return failureResponse(error);
			}
		},
	};
}

/** Missing or unusable deployment configuration; the route answers 503. */
export class ArtifactReadNotConfiguredError extends Error {
	constructor() {
		super("artifact read is not configured");
		this.name = "ArtifactReadNotConfiguredError";
	}
}

type ArtifactReadRuntime = {
	databaseUrl: string;
	baseUrl: string;
	cookieSecret: string;
	auth: AuthRuntime;
	artifacts: ArtifactPayloadRepository;
};

let sql: PgSql | undefined;
let sqlUrl: string | undefined;
let runtime: ArtifactReadRuntime | undefined;

function getSql(databaseUrl: string): PgSql {
	if (sql === undefined || sqlUrl !== databaseUrl) {
		sql = createDb(databaseUrl);
		sqlUrl = databaseUrl;
	}
	return sql;
}

/** Production wiring: same auth/runtime pattern as the trace read route. */
export function getArtifactReadRoutes(
	env: Record<string, string | undefined> = process.env,
): ArtifactReadRoutes {
	const databaseUrl = env.DATABASE_URL?.trim();
	if (databaseUrl === undefined || databaseUrl.length === 0) {
		throw new ArtifactReadNotConfiguredError();
	}
	const settings = readNeonAuthSettings(env);
	if (settings === null) throw new ControlPlaneError("AUTH_REQUIRED");

	if (
		runtime === undefined ||
		runtime.databaseUrl !== databaseUrl ||
		runtime.baseUrl !== settings.baseUrl ||
		runtime.cookieSecret !== settings.cookieSecret
	) {
		const database = getSql(databaseUrl);
		runtime = {
			databaseUrl,
			baseUrl: settings.baseUrl,
			cookieSecret: settings.cookieSecret,
			auth: createAuthRuntime(database, settings),
			artifacts: new PostgresArtifactPayloadRepository(database),
		};
	}
	const active = runtime;

	return createArtifactReadRoutes({
		resolveScope: () =>
			resolveCallerScope({
				session: active.auth.session,
				memberships: active.auth.memberships,
				preferredOrganizationId: readActiveOrganizationPreference(),
			}),
		artifacts: active.artifacts,
	});
}

/** Test-only seam: drop the process-local bundle. */
export function resetArtifactReadForTests(): void {
	runtime = undefined;
	sql = undefined;
	sqlUrl = undefined;
}

/**
 * Route module adapter. Configuration, auth and database failures all collapse
 * to one fixed 503; the route file stays a one-liner.
 */
export async function handleArtifactPayloadRoute(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): Promise<Response> {
	try {
		return await getArtifactReadRoutes(env).get(request);
	} catch {
		return unavailable();
	}
}
