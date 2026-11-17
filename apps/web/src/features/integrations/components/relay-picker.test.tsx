import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PairingRelay } from "../relay-selection";
import { RelayPicker } from "./relay-picker";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

function relay(
	id: string,
	overrides: Partial<Omit<PairingRelay, "id">> = {},
): PairingRelay {
	return {
		id,
		displayName: id,
		status: "active",
		lastSeenAt: new Date(NOW - 60_000).toISOString(),
		...overrides,
	};
}

function renderPicker({
	relays,
	selectedId,
	nowMs = NOW,
}: {
	relays: readonly PairingRelay[];
	selectedId: string | null;
	nowMs?: number | null;
}) {
	return renderToStaticMarkup(
		<RelayPicker
			relays={relays}
			selectedId={selectedId}
			onSelect={() => {}}
			nowMs={nowMs}
		/>,
	);
}

function optionTags(html: string): string[] {
	return html.match(/<option[^>]*>.*?<\/option>/g) ?? [];
}

describe("RelayPicker", () => {
	test("offers active relays with the most recent heartbeat first and selected", () => {
		const html = renderPicker({
			relays: [
				relay("local", {
					displayName: "Local daemon",
					lastSeenAt: new Date(NOW - 30 * 60_000).toISOString(),
				}),
				relay("verification", {
					displayName: "Verification relay",
					lastSeenAt: new Date(NOW - 60_000).toISOString(),
				}),
			],
			selectedId: "verification",
		});
		const options = optionTags(html);
		expect(options).toHaveLength(2);
		expect(options[0]).toContain('value="verification"');
		expect(options[0]).toContain("Verification relay");
		expect(options[0]).toContain("heartbeat within 5 min");
		expect(options[0]).toContain("selected");
		expect(options[1]).toContain('value="local"');
		expect(options[1]).toContain("heartbeat older than 5 min");
		expect(options[1]).not.toContain("selected");
	});

	test("asserts no freshness before the client measures now", () => {
		const html = renderPicker({
			relays: [relay("recent")],
			selectedId: "recent",
			nowMs: null,
		});
		expect(html).toContain(">recent</option>");
		expect(html).not.toContain("heartbeat");
		expect(html).not.toContain('role="status"');
	});

	test("warns when the selected relay has no recent heartbeat", () => {
		const html = renderPicker({
			relays: [
				relay("local", {
					displayName: "Local daemon",
					lastSeenAt: new Date(NOW - 20 * 60_000).toISOString(),
				}),
				relay("verification", {
					displayName: "Verification relay",
					lastSeenAt: new Date(NOW - 60_000).toISOString(),
				}),
			],
			selectedId: "local",
		});
		expect(html).toContain('role="status"');
		expect(html).toContain("Check which relay daemon you started");
		expect(html).toContain("Verification relay");
	});

	test("stays quiet when the only fresh relay is selected", () => {
		const html = renderPicker({
			relays: [relay("only")],
			selectedId: "only",
		});
		expect(html).not.toContain('role="status"');
	});

	test("keeps a manual selection for a relay without heartbeat data", () => {
		const html = renderPicker({
			relays: [
				relay("never", {
					displayName: "Never seen",
					lastSeenAt: null,
				}),
				relay("fresh", { displayName: "Fresh relay" }),
			],
			selectedId: "never",
		});
		const options = optionTags(html);
		expect(options[1]).toContain('value="never"');
		expect(options[1]).toContain("selected");
		expect(html).toContain("no reliable heartbeat");
	});
});
