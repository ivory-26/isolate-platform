import { RelativeTime } from "@/components/common/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatDurationMs } from "@/lib/format";
import type { RunAttempt } from "../contracts";
import { durationBetween, stableKeys } from "../view";

/**
 * Durable `task_attempts` rows for one task. The read model already bounds the
 * list; `truncated` is set when a further row exists and is never rendered.
 */
export function RunAttempts({
	attempts,
	truncated,
}: {
	attempts: RunAttempt[];
	truncated: boolean;
}) {
	if (attempts.length === 0) {
		return (
			<p className="text-sm text-ink-muted">
				No task attempts were recorded for this run.
			</p>
		);
	}
	const attemptKeys = stableKeys(
		attempts,
		(attempt) => `${attempt.attemptIndex}-${attempt.startedAt}`,
	);
	return (
		<div className="space-y-3">
			<div className="overflow-x-auto border-y border-line-subtle">
				<Table>
					<TableHeader>
						<TableRow className="border-line-subtle hover:bg-transparent">
							<TableHead scope="col" className="w-[90px]">
								Attempt
							</TableHead>
							<TableHead scope="col" className="w-[160px]">
								Status
							</TableHead>
							<TableHead scope="col" className="w-[160px]">
								Started
							</TableHead>
							<TableHead scope="col" className="w-[160px]">
								Finished
							</TableHead>
							<TableHead scope="col" className="w-[100px]">
								Duration
							</TableHead>
							<TableHead scope="col" className="w-[180px]">
								Failure code
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{attempts.map((attempt, index) => (
							<TableRow key={attemptKeys[index]} className="border-line-subtle">
								<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
									{attempt.attemptIndex}
								</TableCell>
								<TableCell>
									<StatusBadge status={attempt.status} />
								</TableCell>
								<TableCell className="text-xs text-ink-muted">
									<RelativeTime value={attempt.startedAt} />
								</TableCell>
								<TableCell className="text-xs text-ink-muted">
									{attempt.finishedAt ? (
										<RelativeTime value={attempt.finishedAt} />
									) : (
										<span className="text-ink-secondary">open</span>
									)}
								</TableCell>
								<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
									{formatDurationMs(
										durationBetween(attempt.startedAt, attempt.finishedAt),
									)}
								</TableCell>
								<TableCell className="max-w-[180px] truncate font-mono text-[11px] text-ink-muted">
									{attempt.errorCode ?? "—"}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			{truncated ? (
				<p className="text-[11px] text-warning">
					Showing the first {attempts.length} attempts; later attempts are not
					included.
				</p>
			) : null}
		</div>
	);
}
