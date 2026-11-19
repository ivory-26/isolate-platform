import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandDialog } from "./command";

describe("CommandDialog", () => {
	/**
	 * Regression: the accessible title/description used to sit outside the
	 * dialog portal, so a closed palette still rendered sr-only nodes into
	 * the fixed shell and contributed layout overflow.
	 */
	test("a closed palette renders no nodes at all", () => {
		const html = renderToStaticMarkup(
			<CommandDialog open={false} onOpenChange={() => {}}>
				<div>palette body</div>
			</CommandDialog>,
		);
		expect(html).toBe("");
	});
});
