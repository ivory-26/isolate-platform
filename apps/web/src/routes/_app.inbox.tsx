import { createFileRoute, Link } from "@tanstack/react-router";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { ConnectorsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

/**
 * Minimal Inbox placeholder for wave 23. The UI-HOME lane owns the event
 * delivery surface and replaces this page; the route exists so primary
 * navigation is never a dead link.
 */
export const Route = createFileRoute("/_app/inbox")({
	validateSearch: (search: Record<string, unknown>) => ({
		status: typeof search.status === "string" ? search.status.slice(0, 32) : "",
		source: typeof search.source === "string" ? search.source.slice(0, 32) : "",
	}),
	component: InboxPage,
});

function InboxPage() {
	return (
		<PageContainer>
			<PageHeader
				title="Inbox"
				description="Event deliveries, source, severity, matched rule, dedupe result and task link for the active organization."
				actions={
					<Button asChild size="sm" variant="outline">
						<Link to="/integrations" search={{ tab: "catalog" }}>
							<ConnectorsIcon />
							Connect a source
						</Link>
					</Button>
				}
			/>
			<ConsoleNote role="note">
				Inbox reads the event delivery ledger. Deliveries appear here after a
				signed provider or bridge delivery is verified; a duplicate is recorded
				as deduplicated and creates no second task.
			</ConsoleNote>
			<EmptyRow
				title="No deliveries yet"
				description="Connect an event source and enable a trigger rule, or send a signed delivery to the webhook intake."
			/>
		</PageContainer>
	);
}
