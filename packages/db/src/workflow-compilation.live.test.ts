import { expect, test } from "bun:test";
import { asOrganizationId, asWorkflowDefinitionId } from "@isolate/shared";
import { createDb } from "./client";
import { PostgresCompiledPlanRepository } from "./repositories/compiled-plan-repository";
import { PostgresWorkflowRejectionRepository } from "./repositories/workflow-rejection-repository";
import { compiledPlan, issue } from "./testing/workflow-compilation-fixtures";

/** Opt-in only. Coordinator must apply 0001 + 0002; this suite never runs DDL. */
const hasDb =
	typeof process.env.DATABASE_URL === "string" &&
	process.env.DATABASE_URL.length > 0;

test.skipIf(!hasDb)(
	"Neon live: compiled plan pins, tenant constraints and append-only rejections",
	async () => {
		const url = process.env.DATABASE_URL;
		if (!url) throw new Error("DATABASE_URL is required for live tests");
		const sql = createDb(url, { max: 2 });
		const orgA = asOrganizationId(crypto.randomUUID());
		const orgB = asOrganizationId(crypto.randomUUID());
		const definitionA = asWorkflowDefinitionId(crypto.randomUUID());
		const definitionB = asWorkflowDefinitionId(crypto.randomUUID());
		const userId = crypto.randomUUID();
		const pin = {
			organizationId: orgA,
			workflowDefinitionId: definitionA,
			workflowVersion: 1,
		};
		try {
			const ready = await sql.unsafe(
				"SELECT to_regclass('public.compiled_plans') AS plans, to_regclass('public.rejection_issues') AS rejections",
			);
			if (!ready[0]?.plans || !ready[0]?.rejections) {
				throw new Error(
					"Coordinator must apply migration 0002 before running workflow compilation live tests",
				);
			}
			await sql.unsafe(
				"INSERT INTO organizations (id, name, slug) VALUES ($1, 'W3-D A', $1::text), ($2, 'W3-D B', $2::text)",
				[orgA, orgB],
			);
			await sql.unsafe(
				"INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'W3-D Live')",
				[userId, `w3-db-${userId}@example.test`],
			);
			await sql.unsafe(
				"INSERT INTO workflow_definitions (id, organization_id, name, created_by) VALUES ($1, $2, 'W3-D A', $5), ($3, $4, 'W3-D B', $5)",
				[definitionA, orgA, definitionB, orgB, userId],
			);
			await sql.unsafe(
				"INSERT INTO workflow_versions (definition_id, version, graph, created_by) VALUES ($1, 1, '{}'::jsonb, $3), ($1, 2, '{}'::jsonb, $3), ($2, 1, '{}'::jsonb, $3)",
				[definitionA, definitionB, userId],
			);
			const plans = new PostgresCompiledPlanRepository(sql);
			const rejections = new PostgresWorkflowRejectionRepository(sql);
			const plan = compiledPlan(pin);
			const racing = await Promise.all([
				plans.save({ ...pin, plan }),
				plans.save({ ...pin, plan }),
			]);
			expect(racing.filter((r) => r.ok)).toHaveLength(1);
			expect(racing.filter((r) => !r.ok)).toEqual([
				{ ok: false, code: "CONFLICT" },
			]);
			expect((await plans.get(orgA, definitionA, 1))?.plan).toEqual(plan);
			expect(
				await plans.save({ ...pin, plan: { ...plan, planId: "replacement" } }),
			).toEqual({ ok: false, code: "CONFLICT" });
			expect((await plans.get(orgA, definitionA, 1))?.plan).toEqual(plan);
			const v2 = { ...pin, workflowVersion: 2 };
			expect((await plans.save({ ...v2, plan: compiledPlan(v2) })).ok).toBe(
				true,
			);
			expect(
				(await plans.list(orgA, definitionA)).map((r) => r.workflow_version),
			).toEqual([2, 1]);
			expect(
				(await plans.listVersions(orgA, definitionA)).map(
					(r) => r.workflow_version,
				),
			).toEqual([2, 1]);
			for (const absent of [
				{ ...pin, organizationId: orgB },
				{ ...pin, workflowDefinitionId: definitionB },
				{ ...pin, workflowVersion: 3 },
			]) {
				expect(
					await plans.save({ ...absent, plan: compiledPlan(absent) }),
				).toEqual({ ok: false, code: "NOT_FOUND" });
				expect(
					await plans.get(
						absent.organizationId,
						absent.workflowDefinitionId,
						absent.workflowVersion,
					),
				).toBeNull();
				expect(await rejections.record({ ...absent, issues: [issue] })).toEqual(
					{ ok: false, code: "NOT_FOUND" },
				);
				expect(
					await rejections.listLatest(
						absent.organizationId,
						absent.workflowDefinitionId,
						absent.workflowVersion,
					),
				).toEqual([]);
			}
			expect(await plans.list(orgB, definitionA)).toEqual([]);
			expect((await rejections.record({ ...pin, issues: [issue] })).ok).toBe(
				true,
			);
			expect(
				(
					await rejections.record({
						...pin,
						issues: [{ ...issue, message: "later rejection" }],
					})
				).ok,
			).toBe(true);
			expect((await rejections.record({ ...v2, issues: [issue] })).ok).toBe(
				true,
			);
			const latest = await rejections.listLatest(orgA, definitionA, 1, 1);
			expect(latest[0].issues[0].message).toBe("later rejection");
			expect(await rejections.listLatest(orgA, definitionA, 1)).toHaveLength(2);

			// Bypass repositories to verify database-enforced tenant/version FKs.
			const insertPlan =
				"INSERT INTO compiled_plans (organization_id, workflow_definition_id, workflow_version, plan) VALUES ($1, $2, $3, $4::jsonb)";
			for (const bad of [
				{ ...pin, organizationId: orgB },
				{ ...pin, workflowVersion: 3 },
			]) {
				await expect(
					sql.unsafe(insertPlan, [
						bad.organizationId,
						bad.workflowDefinitionId,
						bad.workflowVersion,
						JSON.stringify(compiledPlan(bad)),
					]),
				).rejects.toMatchObject({ code: "23503" });
				await expect(
					sql.unsafe(
						"INSERT INTO rejection_issues (organization_id, workflow_definition_id, workflow_version, issues) VALUES ($1, $2, $3, $4::jsonb)",
						[
							bad.organizationId,
							bad.workflowDefinitionId,
							bad.workflowVersion,
							JSON.stringify([issue]),
						],
					),
				).rejects.toMatchObject({ code: "23503" });
			}
			await expect(
				sql.unsafe(insertPlan, [orgA, definitionA, 1, JSON.stringify(plan)]),
			).rejects.toMatchObject({ code: "23505" });
			await expect(
				sql.unsafe(insertPlan, [
					orgA,
					definitionA,
					0,
					JSON.stringify({ ...plan, versionPinned: 0 }),
				]),
			).rejects.toMatchObject({ code: "23514" });
			await expect(
				sql.unsafe(insertPlan, [orgA, definitionA, 2, JSON.stringify(plan)]),
			).rejects.toMatchObject({ code: "23514" });
		} finally {
			const teardown: Array<[string, string[]]> = [
				[
					"DELETE FROM rejection_issues WHERE workflow_definition_id IN ($1, $2)",
					[definitionA, definitionB],
				],
				[
					"DELETE FROM compiled_plans WHERE workflow_definition_id IN ($1, $2)",
					[definitionA, definitionB],
				],
				[
					"DELETE FROM workflow_versions WHERE definition_id IN ($1, $2)",
					[definitionA, definitionB],
				],
				[
					"DELETE FROM workflow_definitions WHERE id IN ($1, $2)",
					[definitionA, definitionB],
				],
				["DELETE FROM users WHERE id = $1", [userId]],
				["DELETE FROM organizations WHERE id IN ($1, $2)", [orgA, orgB]],
			];
			try {
				// Exact fixture UUIDs only; incomplete setup must not mask the test error.
				for (const [statement, params] of teardown) {
					try {
						await sql.unsafe(statement, params);
					} catch {
						// Best effort only, matching the existing live suite (DDL may be absent).
					}
				}
			} finally {
				await sql.end({ timeout: 5 });
			}
		}
	},
	120000,
);
