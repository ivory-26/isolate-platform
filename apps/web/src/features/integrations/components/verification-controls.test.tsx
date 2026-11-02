import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectorVerificationResult } from "../verification";
import { VerificationControls } from "./verification-controls";

function renderControls({
	status,
	storedVerifiedAt = null,
	outcome = null,
	isPending = false,
}: {
	status: string;
	storedVerifiedAt?: string | null;
	outcome?: ConnectorVerificationResult | null;
	isPending?: boolean;
}) {
	return renderToStaticMarkup(
		<VerificationControls
			status={status}
			storedVerifiedAt={storedVerifiedAt}
			outcome={outcome}
			isPending={isPending}
			onVerify={() => {}}
		/>,
	);
}

function buttonTag(html: string): string {
	return html.match(/<button[^>]*data-slot="button"[^>]*>/)?.[0] ?? "";
}

function isButtonDisabled(html: string): boolean {
	return /<button[^>]*\sdisabled(?:=""|(?=[\s>]))[^>]*>/.test(html);
}

describe("VerificationControls", () => {
	test("offers Verify connection for a pending credential", () => {
		const html = renderControls({ status: "pending_validation" });
		expect(html).toContain("Verify connection");
		expect(html).toContain("Verification pending");
		expect(html).not.toContain("Connected");
		expect(isButtonDisabled(html)).toBe(false);
	});

	test("keeps the action enabled for active and invalid credentials", () => {
		for (const status of ["active", "invalid"]) {
			const html = renderControls({ status });
			expect(html).toContain("Verify connection");
			expect(isButtonDisabled(html)).toBe(false);
		}
	});

	test("shows a busy state and disables the action while in flight", () => {
		const html = renderControls({
			status: "pending_validation",
			isPending: true,
		});
		expect(html).toContain("Verifying…");
		expect(html).toContain("Waiting for the relay");
		expect(html).not.toContain("Verification succeeded");
		expect(buttonTag(html)).toContain("disabled");
		expect(buttonTag(html)).toContain('aria-busy="true"');
	});

	test("shows active, verified time and reason OK after a success", () => {
		const html = renderControls({
			status: "pending_validation",
			outcome: {
				ok: true,
				value: {
					credentialId: "33333333-3333-4333-8333-333333333333",
					status: "active",
					reasonCode: "OK",
					verifiedAt: "2026-11-02T10:00:00.000Z",
				},
			},
		});
		expect(html).toContain("Connected");
		expect(html).toContain("Verified");
		expect(html).toContain("Reason OK");
		expect(html).toContain("2026-11-02T10:00:00.000Z");
		expect(html).toContain("Verification succeeded");
	});

	test("shows the fixed rejection label and keeps reconnect guidance", () => {
		const html = renderControls({
			status: "pending_validation",
			outcome: {
				ok: true,
				value: {
					credentialId: "33333333-3333-4333-8333-333333333333",
					status: "invalid",
					reasonCode: "AUTH_FAILED",
					verifiedAt: null,
				},
			},
		});
		expect(html).toContain("Verification failed");
		expect(html).toContain("Authentication failed");
		expect(html).toContain("AUTH_FAILED");
		expect(html).toContain("Reconnect");
		expect(html).not.toContain("Verification succeeded");
	});

	test("keeps the current status when the relay does not answer", () => {
		const html = renderControls({
			status: "pending_validation",
			outcome: {
				ok: true,
				value: {
					credentialId: "33333333-3333-4333-8333-333333333333",
					status: "pending_validation",
					reasonCode: "UNREACHABLE",
					verifiedAt: null,
				},
			},
		});
		expect(html).toContain("did not answer");
		expect(html).toContain("not verified");
		expect(html).not.toContain("Verification succeeded");
		expect(html).not.toContain("Connected");
	});

	test("shows a fixed request failure without claiming verification", () => {
		const html = renderControls({
			status: "active",
			outcome: {
				ok: false,
				error: {
					code: "RATE_LIMITED",
					message: "Too many verification requests. Try again shortly.",
					retryAfterSeconds: 30,
				},
			},
		});
		expect(html).toContain("Too many verification requests");
		expect(html).toContain("Try again in 30 seconds");
		expect(html).not.toContain("Verification succeeded");
	});

	test("disables the action for a revoked connection", () => {
		const html = renderControls({ status: "revoked" });
		expect(isButtonDisabled(html)).toBe(true);
		expect(html).toContain("cannot be verified");
		expect(html).not.toContain("Connected");
	});
});
