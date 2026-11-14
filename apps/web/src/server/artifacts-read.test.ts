import { describe, expect, test } from "bun:test";
import { MAX_BLOB_BYTES, type PgSql, type UserRole } from "@isolate/db";
import { asOrganizationId, asUserId } from "@isolate/shared";
import {
	type ArtifactPayloadInput,
	type ArtifactPayloadRepository,
	type ArtifactPayloadView,
	type ArtifactReadRoutes,
	artifactDownloadName,
	createArtifactReadRoutes,
	createArtifactReadService,
	handleArtifactPayloadRoute,
	normalizeArtifactId,
	PostgresArtifactPayloadRepository,
	readArtifactId,
	resetArtifactReadForTests,
	safeArtifactContentType,
} from "./artifacts-read.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const USER_A = asUserId("22222222-2222-4222-8222-222222222222");
const ARTIFACT_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_ID = "44444444-4444-4444-8444-444444444444";

const PAYLOAD = new TextEncoder().encode("diff --git a/x b/x\n");

function fixturePayload(
	overrides: Partial<ArtifactPayloadView> = {},
): ArtifactPayloadView {
	return {
		artifactId: ARTIFACT_ID,
		bytes: PAYLOAD,
		contentType: "text/x-diff",
		kind: "diff",
		...overrides,
	};
}

class RecordingArtifactRepository implements ArtifactPayloadRepository {
	readonly calls: ArtifactPayloadInput[] = [];

	constructor(
		private readonly result: ArtifactPayloadView | null,
		private readonly failure: Error | null = null,
	) {}

	async getArtifactPayload(
		input: ArtifactPayloadInput,
	): Promise<ArtifactPayloadView | null> {
		this.calls.push(input);
		if (this.failure !== null) throw this.failure;
		return this.result;
	}
}

function scope(role: UserRole = "member"): CallerScope {
	return { organizationId: ORG_A, userId: USER_A, role };
}

type Harness = {
	routes: ArtifactReadRoutes;
	artifacts: RecordingArtifactRepository;
	scopeCalls: () => number;
};

function setup(
	options: {
		role?: UserRole;
		result?: ArtifactPayloadView | null;
		failure?: Error;
		missingScope?: boolean;
	} = {},
): Harness {
	let scopeCalls = 0;
	const artifacts = new RecordingArtifactRepository(
		options.result === undefined ? fixturePayload() : options.result,
		options.failure ?? null,
	);
	const routes = createArtifactReadRoutes({
		resolveScope: async () => {
			scopeCalls += 1;
			if (options.missingScope === true) {
				throw new ControlPlaneError("AUTH_REQUIRED");
			}
			return scope(options.role ?? "member");
		},
		artifacts,
	});
	return { routes, artifacts, scopeCalls: () => scopeCalls };
}

function get(artifactId: string, init: RequestInit = {}): Request {
	return new Request(`http://localhost/api/artifacts/${artifactId}`, {
		method: "GET",
		...init,
	});
}

async function body(response: Response): Promise<Record<string, unknown>> {
	const parsed: unknown = await response.json();
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("expected a JSON object");
	}
	return parsed as Record<string, unknown>;
}

describe("artifact read service", () => {
	test("checks task:read before touching storage", async () => {
		const artifacts = new RecordingArtifactRepository(fixturePayload());
		const service = createArtifactReadService({
			resolveScope: async () => scope(),
			artifacts,
		});
		await expect(
			service.getArtifactPayload(scope("intruder" as UserRole), {
				artifactId: ARTIFACT_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(artifacts.calls).toHaveLength(0);
	});

	test("scopes the storage read to the caller's organization", async () => {
		const artifacts = new RecordingArtifactRepository(fixturePayload());
		const service = createArtifactReadService({
			resolveScope: async () => scope(),
			artifacts,
		});
		const payload = await service.getArtifactPayload(scope("viewer"), {
			artifactId: ARTIFACT_ID.toUpperCase(),
		});
		expect(payload.artifactId).toBe(ARTIFACT_ID);
		expect(artifacts.calls).toEqual([
			{ organizationId: ORG_A, artifactId: ARTIFACT_ID },
		]);
	});

	test("a foreign, missing or inline-only artifact is one fixed NOT_FOUND", async () => {
		const artifacts = new RecordingArtifactRepository(null);
		const service = createArtifactReadService({
			resolveScope: async () => scope(),
			artifacts,
		});
		await expect(
			service.getArtifactPayload(scope(), { artifactId: MISSING_ID }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "artifact not found",
		});
	});

	test("rejects a malformed artifact id before any storage read", async () => {
		const artifacts = new RecordingArtifactRepository(fixturePayload());
		const service = createArtifactReadService({
			resolveScope: async () => scope(),
			artifacts,
		});
		await expect(
			service.getArtifactPayload(scope(), { artifactId: "not-a-uuid" }),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		await expect(
			service.getArtifactPayload(scope(), null),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		expect(artifacts.calls).toHaveLength(0);
	});
});

describe("artifact read route", () => {
	test("serves bounded bytes as a no-store attachment", async () => {
		const harness = setup();
		const response = await harness.routes.get(get(ARTIFACT_ID));
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");
		expect(response.headers.get("content-type")).toBe("text/x-diff");
		expect(response.headers.get("content-length")).toBe(
			String(PAYLOAD.byteLength),
		);
		expect(response.headers.get("content-disposition")).toBe(
			`attachment; filename="diff-33333333.diff"`,
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PAYLOAD);
		expect(harness.artifacts.calls[0]?.organizationId).toBe(ORG_A);
	});

	test("never reflects an unsafe stored content type or kind", async () => {
		const harness = setup({
			result: fixturePayload({
				contentType: "text/html\r\nset-cookie: a=b",
				kind: "../../etc/passwd",
			}),
		});
		const response = await harness.routes.get(get(ARTIFACT_ID));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("content-disposition")).toBe(
			`attachment; filename="artifact-33333333.bin"`,
		);
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	test("normalizes an upper-case id and rejects a malformed path with 400", async () => {
		const harness = setup();
		expect(
			(await harness.routes.get(get(ARTIFACT_ID.toUpperCase()))).status,
		).toBe(200);
		expect(harness.artifacts.calls[0]?.artifactId).toBe(ARTIFACT_ID);

		const malformed = await harness.routes.get(get("not-a-uuid"));
		expect(malformed.status).toBe(400);
		expect(await body(malformed)).toEqual({
			error: "artifact request is invalid",
		});
		// The path is refused before a session lookup.
		expect(harness.scopeCalls()).toBe(1);
		expect(harness.artifacts.calls).toHaveLength(1);
	});

	test("maps missing auth, forbidden, not found and failure to fixed bodies", async () => {
		const unauthenticated = setup({ missingScope: true });
		const unauthorized = await unauthenticated.routes.get(get(ARTIFACT_ID));
		expect(unauthorized.status).toBe(401);
		expect(await body(unauthorized)).toEqual({
			error: "authentication required",
		});

		const forbidden = setup({ role: "intruder" as UserRole });
		const denied = await forbidden.routes.get(get(ARTIFACT_ID));
		expect(denied.status).toBe(403);
		expect(await body(denied)).toEqual({ error: "forbidden" });
		expect(forbidden.artifacts.calls).toHaveLength(0);

		const missing = setup({ result: null });
		const notFound = await missing.routes.get(get(MISSING_ID));
		expect(notFound.status).toBe(404);
		expect(await body(notFound)).toEqual({ error: "artifact not found" });

		const broken = setup({ failure: new Error("driver password: hunter2") });
		const unavailable = await broken.routes.get(get(ARTIFACT_ID));
		expect(unavailable.status).toBe(503);
		const fixed = await body(unavailable);
		expect(fixed).toEqual({ error: "artifact read is unavailable" });
		expect(JSON.stringify(fixed)).not.toContain("driver");
	});

	test("refuses a non-GET method and a cross-origin request", async () => {
		const harness = setup();
		const post = await harness.routes.get(
			new Request(`http://localhost/api/artifacts/${ARTIFACT_ID}`, {
				method: "POST",
			}),
		);
		expect(post.status).toBe(405);

		const crossOrigin = await harness.routes.get(
			get(ARTIFACT_ID, { headers: { origin: "https://evil.example" } }),
		);
		expect(crossOrigin.status).toBe(403);
		expect(await body(crossOrigin)).toEqual({ error: "request rejected" });
		// The guard runs before a session lookup or a query.
		expect(harness.scopeCalls()).toBe(0);
		expect(harness.artifacts.calls).toHaveLength(0);
	});

	test("the production handler answers a fixed 503 without configuration", async () => {
		resetArtifactReadForTests();
		const response = await handleArtifactPayloadRoute(get(ARTIFACT_ID), {});
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await body(response)).toEqual({
			error: "artifact read is unavailable",
		});
	});
});

type SqlCall = { statement: string; params: readonly unknown[] };

function scriptedSql(
	respond: (statement: string, params: readonly unknown[]) => unknown[],
): { sql: PgSql; calls: SqlCall[] } {
	const calls: SqlCall[] = [];
	const sql = {
		unsafe: async (statement: string, params: unknown[] = []) => {
			calls.push({ statement, params });
			return respond(statement, params);
		},
	} as unknown as PgSql;
	return { sql, calls };
}

const SHA = "a".repeat(64);

function artifactRow(overrides: Record<string, unknown> = {}) {
	return {
		kind: "diff",
		content_type: "text/x-diff",
		storage_ref: `blob:${SHA}`,
		...overrides,
	};
}

describe("PostgresArtifactPayloadRepository", () => {
	test("reads the artifact row and blob under the caller's organization", async () => {
		const { sql, calls } = scriptedSql((statement) => {
			if (statement.includes("FROM artifacts a")) return [artifactRow()];
			if (statement.includes("FROM blobs")) {
				return [
					{
						organization_id: ORG_A,
						task_id: null,
						kind: "diff",
						content_type: "text/x-diff",
						byte_size: 3,
						sha256: SHA,
						bytes: new Uint8Array([1, 2, 3]),
					},
				];
			}
			throw new Error(`Unexpected statement: ${statement.slice(0, 40)}`);
		});
		const repository = new PostgresArtifactPayloadRepository(sql);
		const payload = await repository.getArtifactPayload({
			organizationId: ORG_A,
			artifactId: ARTIFACT_ID,
		});
		expect(payload).toEqual({
			artifactId: ARTIFACT_ID,
			bytes: new Uint8Array([1, 2, 3]),
			contentType: "text/x-diff",
			kind: "diff",
		});
		expect(calls[0]?.params).toEqual([ORG_A, ARTIFACT_ID]);
		expect(calls[1]?.params).toEqual([ORG_A, SHA]);
	});

	test("an inline-only artifact has no downloadable payload", async () => {
		const { sql, calls } = scriptedSql(() => [
			artifactRow({ storage_ref: `inline:${SHA}` }),
		]);
		const repository = new PostgresArtifactPayloadRepository(sql);
		expect(
			await repository.getArtifactPayload({
				organizationId: ORG_A,
				artifactId: ARTIFACT_ID,
			}),
		).toBeNull();
		expect(calls).toHaveLength(1);
	});

	test("refuses stored bytes above the blob cap", async () => {
		const { sql } = scriptedSql((statement) => {
			if (statement.includes("FROM artifacts a")) return [artifactRow()];
			return [
				{
					organization_id: ORG_A,
					task_id: null,
					kind: "diff",
					content_type: "text/x-diff",
					byte_size: MAX_BLOB_BYTES + 1,
					sha256: SHA,
					bytes: new Uint8Array(MAX_BLOB_BYTES + 1),
				},
			];
		});
		const repository = new PostgresArtifactPayloadRepository(sql);
		expect(
			await repository.getArtifactPayload({
				organizationId: ORG_A,
				artifactId: ARTIFACT_ID,
			}),
		).toBeNull();
	});

	test("a missing artifact row or blob is null", async () => {
		const missingArtifact = scriptedSql(() => []);
		expect(
			await new PostgresArtifactPayloadRepository(
				missingArtifact.sql,
			).getArtifactPayload({
				organizationId: ORG_A,
				artifactId: MISSING_ID,
			}),
		).toBeNull();

		const missingBlob = scriptedSql((statement) =>
			statement.includes("FROM artifacts a") ? [artifactRow()] : [],
		);
		expect(
			await new PostgresArtifactPayloadRepository(
				missingBlob.sql,
			).getArtifactPayload({
				organizationId: ORG_A,
				artifactId: ARTIFACT_ID,
			}),
		).toBeNull();
	});
});

describe("path and header helpers", () => {
	test("readArtifactId takes only the last segment under /artifacts", () => {
		expect(readArtifactId(get(ARTIFACT_ID))).toBe(ARTIFACT_ID);
		expect(readArtifactId(get(`${ARTIFACT_ID}/extra`))).toBeNull();
		expect(
			readArtifactId(new Request("http://localhost/api/artifacts/")),
		).toBeNull();
		expect(normalizeArtifactId("ABC")).toBeNull();
		expect(normalizeArtifactId(ARTIFACT_ID.toUpperCase())).toBe(ARTIFACT_ID);
	});

	test("safeArtifactContentType accepts only a bare type/subtype", () => {
		expect(safeArtifactContentType("text/x-diff")).toBe("text/x-diff");
		expect(safeArtifactContentType("Text/Plain")).toBe("text/plain");
		expect(safeArtifactContentType("text/html; charset=utf-8")).toBe(
			"application/octet-stream",
		);
		expect(safeArtifactContentType("text/html\r\nset-cookie: a=b")).toBe(
			"application/octet-stream",
		);
		expect(safeArtifactContentType(null)).toBe("application/octet-stream");
	});

	test("artifactDownloadName uses bounded fields and a known extension", () => {
		expect(artifactDownloadName(ARTIFACT_ID, "diff", "text/x-diff")).toBe(
			"diff-33333333.diff",
		);
		expect(artifactDownloadName(ARTIFACT_ID, "log_bundle", "text/plain")).toBe(
			"log_bundle-33333333.log",
		);
		expect(artifactDownloadName(ARTIFACT_ID, "report", "application/pdf")).toBe(
			"report-33333333.bin",
		);
		expect(artifactDownloadName(ARTIFACT_ID, "../sh", "text/plain")).toBe(
			"artifact-33333333.log",
		);
	});
});
