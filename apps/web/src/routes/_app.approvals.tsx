import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/auth/SessionProvider";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { RetryIcon, ShieldIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ApprovalDetailSheet } from "@/features/approvals/components/approval-detail-sheet";
import {
	DecidedApprovalsSection,
	PendingApprovalsSection,
} from "@/features/approvals/components/approval-sections";
import { ApprovalsSkeleton } from "@/features/approvals/components/approvals-skeleton";
import type { ApprovalItem } from "@/features/approvals/contracts";
import { approvalKeys, approvalsOptions } from "@/features/approvals/queries";
import { activeRole } from "@/features/auth/guard";
import { overviewKeys } from "@/features/overview/queries";
import { taskKeys } from "@/features/tasks/queries";
import { decideApproval } from "@/features/tasks/tasks.functions";

export const Route = createFileRoute("/_app/approvals")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(approvalsOptions()),
	component: ApprovalsPage,
	pendingComponent: ApprovalsSkeleton,
});

type DecisionVariables = {
	item: ApprovalItem;
	decision: "approved" | "rejected";
};

function ApprovalsPage() {
	const query = useSuspenseQuery(approvalsOptions());
	const session = useSession();
	const queryClient = useQueryClient();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const canDecide =
		activeRole(session) !== "viewer" && session.mode !== "anonymous";

	const mutation = useMutation({
		mutationFn: (variables: DecisionVariables) =>
			decideApproval({
				data: {
					taskId: variables.item.taskId,
					approvalId: variables.item.id,
					decision: variables.decision,
				},
			}),
		onSuccess: async (result, variables) => {
			if (!result.ok) {
				toast.error(result.error.message);
				return;
			}
			toast.success(
				variables.decision === "approved"
					? "Approval recorded. The follow-up job is queued."
					: "Approval rejected. The task will not continue past this gate.",
			);
			setSelectedId(null);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: approvalKeys.all }),
				queryClient.invalidateQueries({ queryKey: overviewKeys.all }),
				queryClient.invalidateQueries({ queryKey: taskKeys.all }),
			]);
		},
		onError: () => {
			toast.error("The decision could not be sent. Nothing was changed.");
		},
	});

	const result = query.data;
	const snapshot = result.ok ? result.value : null;
	const items = snapshot ? [...snapshot.pending, ...snapshot.decided] : [];
	const selected = items.find((item) => item.id === selectedId) ?? null;
	const mutationError =
		mutation.data && !mutation.data.ok
			? mutation.data.error.message
			: mutation.isError
				? "The decision request could not be confirmed. Nothing is assumed; retry once."
				: null;

	const openApproval = (item: ApprovalItem) => {
		mutation.reset();
		setSelectedId(item.id);
	};

	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Approvals"
				description="Human decisions that unblock a run. Each approval is bound to the exact action, target and payload hash it authorizes."
				actions={
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={query.isFetching}
						onClick={() => void query.refetch()}
					>
						<RetryIcon />
						{query.isFetching ? "Refreshing…" : "Refresh"}
					</Button>
				}
			/>

			{!canDecide ? (
				<div
					role="alert"
					className="flex items-start gap-2 rounded-md border border-line-subtle bg-elevated px-3 py-2 text-sm text-ink-secondary"
				>
					<ShieldIcon size={16} className="mt-0.5 text-ink-muted" />
					<span>
						Your role can review approvals but cannot decide them. Ask an owner,
						admin or member to act on this queue.
					</span>
				</div>
			) : null}

			{snapshot === null ? (
				<ErrorState
					title="Approvals unavailable"
					message={
						result.ok
							? "The approval queue could not be loaded."
							: result.error.message
					}
					onRetry={() => void query.refetch()}
				/>
			) : (
				<>
					{query.isRefetchError ? (
						<output className="block rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
							Refresh failed. The queue below may be stale; re-read before
							deciding.
						</output>
					) : null}

					<PendingApprovalsSection
						items={snapshot.pending}
						onReview={openApproval}
					/>
					<DecidedApprovalsSection
						items={snapshot.decided}
						onReview={openApproval}
					/>
				</>
			)}

			<ApprovalDetailSheet
				key={selected?.id ?? "no-selection"}
				item={selected}
				open={selected !== null}
				onOpenChange={(open) => {
					if (!open) {
						setSelectedId(null);
						mutation.reset();
					}
				}}
				canDecide={canDecide}
				pending={mutation.isPending}
				error={mutationError}
				onDecide={(decision) => {
					if (selected === null) return;
					mutation.mutate({ item: selected, decision });
				}}
			/>
		</PageContainer>
	);
}
