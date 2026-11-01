import type { ReactNode } from "react";
import { RetryIcon, WarningIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ErrorState({
	title = "Could not load this data",
	message,
	onRetry,
	action,
	className,
}: {
	title?: ReactNode;
	message: ReactNode;
	onRetry?: () => void;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			role="alert"
			className={cn(
				"flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/5 p-4",
				className,
			)}
		>
			<WarningIcon size={18} className="mt-0.5 text-danger" />
			<div className="min-w-0 flex-1 space-y-1.5">
				<p className="text-sm font-medium text-ink">{title}</p>
				<p className="text-sm leading-6 text-ink-secondary">{message}</p>
				{onRetry ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-1"
						onClick={onRetry}
					>
						<RetryIcon />
						Retry
					</Button>
				) : null}
				{action}
			</div>
		</div>
	);
}
