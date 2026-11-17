import { RelativeTime } from "@/components/common/relative-time";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatDurationMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RunEventView } from "../contracts";
import {
	formatBytes,
	type RunValidationEntry,
	stableKeys,
	validationEntries,
} from "../view";

/**
 * Validation outcomes parsed from durable `validation.finished` events. The
 * worker records a `command` stage (exit code, duration, output bytes) and a
 * `diff` stage (file counts, stored bytes); fields the stage did not record
 * stay blank. No row is synthesized when no event exists.
 */
export function RunValidation({
	events,
	eventsTruncated = false,
}: {
	events: RunEventView[];
	/** The event window was capped, so a later outcome may be missing. */
	eventsTruncated?: boolean;
}) {
	const entries = validationEntries(events);
	if (entries.length === 0) {
		return (
			<p className="text-sm text-ink-muted">
				No validation outcome was recorded for this run.
			</p>
		);
	}
	const entryKeys = stableKeys(
		entries,
		(entry) =>
			`${entry.createdAt}-${entry.stage ?? "unknown"}-${entry.status ?? "none"}`,
	);
	return (
		<div className="space-y-3">
			<div className="overflow-x-auto border-y border-line-subtle">
				<Table>
					<TableHeader>
						<TableRow className="border-line-subtle hover:bg-transparent">
							<TableHead scope="col" className="w-[100px]">
								Stage
							</TableHead>
							<TableHead scope="col">Result</TableHead>
							<TableHead scope="col" className="w-[90px]">
								Exit code
							</TableHead>
							<TableHead scope="col" className="w-[100px]">
								Duration
							</TableHead>
							<TableHead scope="col" className="w-[110px]">
								Output
							</TableHead>
							<TableHead scope="col" className="w-[100px]">
								Truncated
							</TableHead>
							<TableHead scope="col" className="w-[150px]">
								Recorded
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{entries.map((entry, index) => (
							<TableRow key={entryKeys[index]} className="border-line-subtle">
								<TableCell className="font-mono text-xs text-ink-secondary">
									{entry.stage ?? "—"}
								</TableCell>
								<TableCell>
									<ValidationResult entry={entry} />
								</TableCell>
								<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
									{entry.exitCode ?? "—"}
								</TableCell>
								<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
									{formatDurationMs(entry.durationMs)}
								</TableCell>
								<TableCell className="font-mono text-xs tabular-nums text-ink-secondary">
									{formatBytes(entry.outputBytes ?? entry.bytes)}
								</TableCell>
								<TableCell className="text-xs text-ink-muted">
									{entry.truncated === null
										? "—"
										: entry.truncated
											? "yes"
											: "no"}
								</TableCell>
								<TableCell className="text-xs text-ink-muted">
									<RelativeTime value={entry.createdAt} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			{eventsTruncated ? (
				<p className="text-[11px] text-warning">
					The event window is capped, so an earlier or later validation outcome
					may not be shown here.
				</p>
			) : null}
		</div>
	);
}

function ValidationResult({ entry }: { entry: RunValidationEntry }) {
	if (entry.status !== null) {
		const tone =
			entry.status === "passed"
				? "bg-success"
				: entry.status === "failed"
					? "bg-danger"
					: "bg-ink-muted";
		return (
			<span className="inline-flex items-center gap-2 text-[11px] text-ink-secondary">
				<span
					aria-hidden="true"
					className={cn("size-1.5 rounded-full", tone)}
				/>
				{entry.status.replaceAll("_", " ")}
			</span>
		);
	}
	if (entry.stage === "diff" && entry.filesChanged !== null) {
		const lineDelta =
			entry.insertions !== null || entry.deletions !== null
				? ` (+${entry.insertions ?? "—"} / -${entry.deletions ?? "—"})`
				: "";
		return (
			<span className="font-mono text-[11px] text-ink-secondary">
				{entry.filesChanged} files{lineDelta}
			</span>
		);
	}
	return <span className="text-xs text-ink-muted">—</span>;
}
