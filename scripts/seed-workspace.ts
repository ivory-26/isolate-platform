import { strict as assert } from "node:assert";
import { createDb } from "../packages/db/src/client";
import { compileWorkflow } from "../packages/workflow-schema/src/compiler";

/**
 * Wave 7 workspace seed (coordinator-owned).
 *
 * Creates the three rows a task submission needs in Postgres mode: a
 * repository, a workflow definition and its pinned version 1. It is additive
 * and idempotent: existing rows are reused, never overwritten.
 *
 * Required environment:
 * - DATABASE_URL
 * - SEED_ORGANIZATION_ID, SEED_USER_ID (the caller must already be a member)
 *
 * Optional:
 * - SEED_REPOSITORY_FULL_NAME (default `octocat/Hello-World`)
 * - SEED_DEFAULT_BRANCH (default `master`)
 * - SEED_WORKFLOW_NAME (default `SDLC demo`)
 *
 * The script never prints the database URL or any credential.
 */

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,120}$/;

function fail(message: string): never {
	console.error(`SEED REFUSED: ${message}`);
	process.exit(1);
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) fail(`${name} is required`);
	return value;
}

function uuid(name: string): string {
	const value = required(name);
	if (!UUID.test(value)) fail(`${name} must be a UUID`);
	return value;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) fail("DATABASE_URL is required");

const organizationId = uuid("SEED_ORGANIZATION_ID");
const userId = uuid("SEED_USER_ID");
const fullName =
	process.env.SEED_REPOSITORY_FULL_NAME?.trim() || "octocat/Hello-World";
if (!FULL_NAME.test(fullName)) fail("SEED_REPOSITORY_FULL_NAME must be owner/name");
const defaultBranch = process.env.SEED_DEFAULT_BRANCH?.trim() || "master";
if (!BRANCH.test(defaultBranch) || defaultBranch.includes("..")) {
	fail("SEED_DEFAULT_BRANCH is not a valid branch name");
}
const workflowName = process.env.SEED_WORKFLOW_NAME?.trim() || "SDLC demo";

/** Minimal valid SDLC graph; the compiler is the authority, not this file. */
function graphFor(definitionId: string) {
	return {
		id: definitionId,
		name: workflowName,
		version: 1,
		nodes: [
			{
				id: "agent",
				type: "task.agent" as const,
				label: "Agent",
				config: { agentId: "coder", promptTemplateId: "sdlc" },
			},
		],
		edges: [],
	};
}

const sql = createDb(databaseUrl);
try {
	const membership = (await sql.unsafe(
		`SELECT role FROM memberships
		 WHERE organization_id = $1::uuid AND user_id = $2::uuid
		 LIMIT 1`,
		[organizationId, userId],
	)) as unknown as Array<{ role: string }>;
	if (membership.length === 0) {
		fail("SEED_USER_ID is not a member of SEED_ORGANIZATION_ID");
	}

	let repositoryId: string;
	const existingRepository = (await sql.unsafe(
		`SELECT id FROM repositories
		 WHERE organization_id = $1::uuid AND external_full_name = $2
		 LIMIT 1`,
		[organizationId, fullName],
	)) as unknown as Array<{ id: string }>;
	if (existingRepository.length > 0) {
		repositoryId = existingRepository[0].id;
	} else {
		const inserted = (await sql.unsafe(
			`INSERT INTO repositories
				(organization_id, provider, external_full_name, default_branch)
			 VALUES ($1::uuid, 'github', $2, $3)
			 RETURNING id`,
			[organizationId, fullName, defaultBranch],
		)) as unknown as Array<{ id: string }>;
		assert.equal(inserted.length, 1, "repository insert returned no row");
		repositoryId = inserted[0].id;
	}

	let definitionId: string;
	const existingDefinition = (await sql.unsafe(
		`SELECT id FROM workflow_definitions
		 WHERE organization_id = $1::uuid AND name = $2
		 ORDER BY created_at ASC
		 LIMIT 1`,
		[organizationId, workflowName],
	)) as unknown as Array<{ id: string }>;
	if (existingDefinition.length > 0) {
		definitionId = existingDefinition[0].id;
	} else {
		const inserted = (await sql.unsafe(
			`INSERT INTO workflow_definitions (organization_id, name, created_by)
			 VALUES ($1::uuid, $2, $3::uuid)
			 RETURNING id`,
			[organizationId, workflowName, userId],
		)) as unknown as Array<{ id: string }>;
		assert.equal(inserted.length, 1, "workflow definition insert returned no row");
		definitionId = inserted[0].id;
	}

	const graph = graphFor(definitionId);
	const compiled = compileWorkflow(graph);
	if (!compiled.ok) {
		fail(
			`seed graph rejected by the compiler (${compiled.error.issues
				.map((issue) => issue.code)
				.join(", ")})`,
		);
	}

	const existingVersion = (await sql.unsafe(
		`SELECT 1 FROM workflow_versions
		 WHERE definition_id = $1::uuid AND version = 1
		 LIMIT 1`,
		[definitionId],
	)) as unknown as Array<unknown>;
	if (existingVersion.length === 0) {
		await sql.unsafe(
			`INSERT INTO workflow_versions
				(definition_id, version, graph, compiled, created_by)
			 VALUES ($1::uuid, 1, $2::text::jsonb, NULL, $3::uuid)`,
			[definitionId, JSON.stringify(graph), userId],
		);
	}

	console.log(
		JSON.stringify(
			{
				seeded: true,
				organizationId,
				repositoryId,
				workflowDefinitionId: definitionId,
				workflowVersion: 1,
				fullName,
				defaultBranch,
			},
			null,
			2,
		),
	);
} finally {
	await sql.end({ timeout: 5 });
}