import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApproveIcon, RejectIcon } from "@/components/icons";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { shellKeys } from "@/features/shell/queries";
import { taskKeys } from "@/features/tasks/queries";
import { decideApproval } from "@/features/tasks/tasks.functions";
import type { RunApproval } from "../contracts";
import { runKeys } from "../queries";
import {
	approvalActionLabel,
	approveConsequence,
	isSupportedApprovalAction,
	rejectConsequence,
} from "../view";

/**
 * Approve / reject for one pending approval, delegated to the existing wave-8
 * `decideApproval` server function (which re-checks `task:submit`, pending
 * status, expiry and payload binding server-side).
 *
 * Both decisions require an explicit dialog step: push and PR approvals act
 * outside the sandbox, and rejection is irreversible for the task. The
 * consequence text comes from a fixed local table, never the row.
 */
export function ApprovalActions({
	taskId,
	approval,
}: {
	taskId: string;
	approval: RunApproval;
}) {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (decision: "approved" | "rejected") =>
			decideApproval({
				data: { taskId, approvalId: approval.id, decision },
			}),
		onSuccess: async (result) => {
			if (!result.ok) {
				toast.error(result.error.message);
				return;
			}
			toast.success(
				result.value.decision === "approved"
					? "Approval recorded. A follow-up job was queued."
					: "Rejection recorded. The task is failed.",
			);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: runKeys.all }),
				queryClient.invalidateQueries({ queryKey: taskKeys.all }),
				queryClient.invalidateQueries({ queryKey: shellKeys.summary }),
			]);
		},
		onError: () => {
			toast.error("The decision could not be recorded. Refresh and try again.");
		},
	});
	const pending = mutation.isPending;
	const supported = isSupportedApprovalAction(approval.action);

	return (
		<div className="flex flex-wrap items-center gap-2">
			{supported ? (
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button size="sm" variant="outline" disabled={pending}>
							<ApproveIcon />
							Approve
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								Approve “{approvalActionLabel(approval.action)}”?
							</AlertDialogTitle>
							<AlertDialogDescription>
								{approveConsequence(approval.action)}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<p className="rounded-md border border-line-subtle bg-elevated px-3 py-2 font-mono text-[11px] break-all text-ink-muted">
							payload sha256: {approval.payloadSha256}
						</p>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
							<AlertDialogAction
								disabled={pending}
								onClick={() => mutation.mutate("approved")}
							>
								{pending ? "Recording…" : "Approve action"}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : (
				<p className="max-w-xs text-xs leading-5 text-ink-muted">
					This action has no server-side approve path. Only rejection is
					supported.
				</p>
			)}

			<AlertDialog>
				<AlertDialogTrigger asChild>
					<Button size="sm" variant="outline" disabled={pending}>
						<RejectIcon />
						Reject
					</Button>
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Reject “{approvalActionLabel(approval.action)}”?
						</AlertDialogTitle>
						<AlertDialogDescription>
							{rejectConsequence()}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={pending}
							onClick={() => mutation.mutate("rejected")}
						>
							{pending ? "Recording…" : "Reject approval"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
