import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { UsageIcon } from "@/components/icons";

export const Route = createFileRoute("/_app/usage")({
	component: UsagePage,
});

function UsagePage() {
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Observe"
				title="Usage"
				description="Measured model tokens, sandbox seconds and recorded cost for the active organization."
			/>
			<EmptyState
				icon={UsageIcon}
				title="Usage analytics are being assembled"
				description="Token, sandbox and cost trends will render here. A null cost means no trusted price was available."
			/>
		</PageContainer>
	);
}
