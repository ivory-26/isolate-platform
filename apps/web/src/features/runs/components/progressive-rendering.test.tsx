import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunEventView } from "../contracts";
import { RunLogViewer } from "./run-log-viewer";
import { RunTimeline } from "./run-timeline";

const TASK_ID = "33333333-3333-4333-8333-333333333333";

function events(count: number): RunEventView[] {
	return Array.from({ length: count }, (_, index) => ({
		type: "tool.call",
		actor: "worker",
		data: { step: index },
		createdAt: new Date(Date.UTC(2026, 10, 20, 10, 0, index)).toISOString(),
	}));
}

function rowCount(html: string, tag: string): number {
	return html.split(`<${tag}`).length - 1;
}

describe("RunTimeline progressive rendering", () => {
	test("a short stream renders every stage with no reveal control", () => {
		const html = renderToStaticMarkup(
			<RunTimeline events={events(20)} traceId={null} taskId={TASK_ID} />,
		);
		expect(rowCount(html, "li")).toBe(20);
		expect(html).not.toContain("earlier event");
	});

	test("a long stream paints the newest window only", () => {
		const html = renderToStaticMarkup(
			<RunTimeline events={events(200)} traceId={null} taskId={TASK_ID} />,
		);
		expect(rowCount(html, "li")).toBe(50);
		expect(html).toContain("Show 50 earlier events");
		expect(html).toContain("150 older not shown");
		// The current stage is still the newest event, not the window's first.
		expect(html).toContain('aria-current="step"');
	});
});

describe("RunLogViewer progressive rendering", () => {
	test("states the visible window out of the full stream", () => {
		const html = renderToStaticMarkup(<RunLogViewer events={events(200)} />);
		expect(html).toContain("50 of 200 events");
		expect(rowCount(html, "li")).toBe(50);
		expect(html).toContain("Show 50 earlier events");
	});

	test("a short stream copies and renders everything", () => {
		const html = renderToStaticMarkup(<RunLogViewer events={events(3)} />);
		expect(html).toContain("3 of 3 events");
		expect(rowCount(html, "li")).toBe(3);
		expect(html).not.toContain("earlier event");
	});
});
