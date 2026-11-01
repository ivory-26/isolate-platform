import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { RetryIcon } from "@/components/icons";
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
import { retryTask } from "@/features/tasks/tasks.functions";
import { RUN_MAX_RETRY_DEPTH, type RunTaskIdentity } from "../contracts";
import { runKeys } from "../queries";
import { canRetryTask } from "../view";

/**
 * Rerun control for a failed task under the retry-depth cap. Calls the existing
 * `retryTask` server function, which re-checks capability, failure state and
 * depth server-side. The client idempotency key is generated once per mount and
 * reused on a replay, so a double submit returns the same task.
 */
export function RetryRunButton({
	task,
}: {
	task: Pick<RunTaskIdentity, "id" | "status" | "retryDepth">;
}) {
	const navigate = useNavigate({ from: "/runs/$taskId" });
	const queryClient = useQueryClient();
	const requestKey = useRef<string>(crypto.randomUUID());
	const [navigating, setNavigating] = useState(false);
	const mutation = useMutation({
		mutationFn: () =>
			retryTask({
				data: { failedTaskId: task.id, idempotencyKey: requestKey.current },
			}),
		onSuccess: async (result) => {
			if (!result.ok) {
				toast.error(result.error.message);
				return;
			}
			toast.success(
				result.value.created
					? "Rerun queued as a new task."
					: "This rerun was already created.",
			);
			setNavigating(true);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: runKeys.all }),
				queryClient.invalidateQueries({ queryKey: taskKeys.all }),
				queryClient.invalidateQueries({ queryKey: shellKeys.summary }),
			]);
			await navigate({
				to: "/runs/$taskId",
				params: { taskId: result.value.taskId },
			});
		},
		onError: () => {
			toast.error("The rerun could not be requested. Try again.");
		},
	});

	if (!canRetryTask(task)) return null;
	const pending = mutation.isPending || navigating;

	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button size="sm" variant="outline" disabled={pending}>
					<RetryIcon />
					Retry
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Rerun this failed task?</AlertDialogTitle>
					<AlertDialogDescription>
						A rerun creates a new task in the same repository and branch
						boundary, with retry depth {task.retryDepth + 1} of{" "}
						{RUN_MAX_RETRY_DEPTH}. The failed task stays failed and is linked as
						the source of the rerun.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={pending}
						onClick={() => mutation.mutate()}
					>
						{pending ? "Requesting…" : "Queue rerun"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
