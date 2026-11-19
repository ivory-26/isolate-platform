import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WORKSPACE_FRAME_CLASS, WorkspaceFrame } from "./workspace-frame";

describe("WorkspaceFrame", () => {
	test("clips the shell instead of making it a scroll container", () => {
		expect(WORKSPACE_FRAME_CLASS).toContain("fixed");
		expect(WORKSPACE_FRAME_CLASS).toContain("overflow-clip");
		expect(WORKSPACE_FRAME_CLASS).not.toContain("overflow-hidden");
		expect(WORKSPACE_FRAME_CLASS).not.toContain("overflow-y-auto");
	});

	test("renders children inside the fixed frame", () => {
		const html = renderToStaticMarkup(
			<WorkspaceFrame className="test-frame">
				<main>workspace content</main>
			</WorkspaceFrame>,
		);
		expect(html).toContain(
			'class="fixed inset-0 overflow-clip bg-canvas text-ink test-frame"',
		);
		expect(html).toContain("<main>workspace content</main>");
	});
});
