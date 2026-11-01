import { describe, expect, test } from "bun:test";
import {
	summarizeWorkflowRow,
	type WorkflowReadRow,
	workflowValidationState,
} from "./summary";

function row(overrides: Partial<WorkflowReadRow> = {}): WorkflowReadRow {
	return {
		id: "40000000-0000-4000-8000-000000000001",
		name: "Ship safely",
		created_at: "2026-11-01T09:00:00.000Z",
		created_by_name: "Ada Lovelace",
		version_count: 3,
		latest_version: 3,
		latest_version_at: "2026-11-02T09:00:00.000Z",
		compiled_plan_count: 2,
		latest_plan_version: 3,
		latest_rejection_issue_count: null,
		latest_rejection_version: null,
		latest_rejection_at: null,
		...overrides,
	};
}

describe("workflowValidationState", () => {
	test("validated when the latest version has a compiled plan", () => {
		expect(
			workflowValidationState({
				latestVersion: 3,
				latestPlanVersion: 3,
				latestRejectionVersion: null,
			}),
		).toBe("validated");
	});

	test("validated wins over an older rejection of the same version", () => {
		expect(
			workflowValidationState({
				latestVersion: 3,
				latestPlanVersion: 3,
				latestRejectionVersion: 3,
			}),
		).toBe("validated");
	});

	test("rejected when the latest version has a rejection and no plan", () => {
		expect(
			workflowValidationState({
				latestVersion: 3,
				latestPlanVersion: 2,
				latestRejectionVersion: 3,
			}),
		).toBe("rejected");
	});

	test("not compiled when the latest version has neither signal", () => {
		expect(
			workflowValidationState({
				latestVersion: 3,
				latestPlanVersion: 2,
				latestRejectionVersion: 2,
			}),
		).toBe("not_compiled");
	});

	test("draft when no immutable version exists", () => {
		expect(
			workflowValidationState({
				latestVersion: null,
				latestPlanVersion: null,
				latestRejectionVersion: null,
			}),
		).toBe("draft");
	});
});

describe("summarizeWorkflowRow", () => {
	test("maps counts and timestamps into the bounded projection", () => {
		const summary = summarizeWorkflowRow(row());
		expect(summary).toEqual({
			id: "40000000-0000-4000-8000-000000000001",
			name: "Ship safely",
			createdBy: "Ada Lovelace",
			createdAt: "2026-11-01T09:00:00.000Z",
			latestVersion: 3,
			latestVersionAt: "2026-11-02T09:00:00.000Z",
			versionCount: 3,
			compiledPlanCount: 2,
			latestRejection: null,
			validationState: "validated",
		});
	});

	test("accepts string counts from the driver and exposes the latest rejection", () => {
		const summary = summarizeWorkflowRow(
			row({
				version_count: "2",
				latest_version: "2",
				compiled_plan_count: "0",
				latest_plan_version: null,
				latest_rejection_issue_count: "4",
				latest_rejection_version: "2",
				latest_rejection_at: new Date("2026-11-03T09:00:00.000Z"),
			}),
		);
		expect(summary.versionCount).toBe(2);
		expect(summary.compiledPlanCount).toBe(0);
		expect(summary.latestRejection).toEqual({
			version: 2,
			issueCount: 4,
			createdAt: "2026-11-03T09:00:00.000Z",
		});
		expect(summary.validationState).toBe("rejected");
	});

	test("keeps an unresolved author null", () => {
		expect(summarizeWorkflowRow(row({ created_by_name: null })).createdBy).toBe(
			null,
		);
	});

	test("fails closed on an invalid timestamp", () => {
		expect(() =>
			summarizeWorkflowRow(row({ created_at: "not-a-date" })),
		).toThrow("invalid timestamp");
	});
});
