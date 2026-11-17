import { Link } from "@tanstack/react-router";
import {
	Pagination,
	useClientPagination,
} from "@/components/common/pagination";
import { RelativeTime } from "@/components/common/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import { DataTable } from "@/components/console/data-table";
import { EmptyRow } from "@/components/console/empty-row";
import { ExternalIcon, InboxIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	EVENT_DELIVERY_STATUSES,
	INBOX_PAGE_SIZE,
	INBOX_SEVERITIES,
	INBOX_SOURCE_OPTIONS,
	type InboxItem,
	type InboxSearch,
	inboxStatusLabel,
	isInboxSeverity,
	isInboxStatus,
} from "./contracts";

const STATUS_OPTIONS = EVENT_DELIVERY_STATUSES.map((status) => ({
	value: status,
	label: inboxStatusLabel(status),
}));

const SEVERITY_LABELS: Record<string, string> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	info: "Info",
};

const COLUMNS = [
	{ key: "received", header: "Received", className: "w-[110px]" },
	{ key: "source", header: "Source", className: "w-[120px]" },
	{ key: "event", header: "Event", className: "w-[170px]" },
	{ key: "severity", header: "Severity", className: "w-[90px]" },
	{ key: "signal", header: "Signal", className: "min-w-[240px]" },
	{ key: "repository", header: "Repository", className: "min-w-[150px]" },
	{ key: "status", header: "Status", className: "w-[160px]" },
	{ key: "task", header: "Task", className: "w-[90px]" },
];

/** Filter bar; every control writes to the URL and returns to page one. */
export function InboxFilters({
	search,
	count,
	onChange,
}: {
	search: InboxSearch;
	/** Rows returned by the server for the active filters. */
	count: number;
	onChange: (changes: Partial<InboxSearch>) => void;
}) {
	const filtered =
		search.status !== undefined ||
		search.source !== undefined ||
		search.severity !== undefined;
	return (
		<div className="flex flex-col gap-3 border-y border-line-subtle py-3 sm:flex-row sm:items-center">
			<div className="flex flex-wrap items-center gap-2">
				<label className="sr-only" htmlFor="inbox-status">
					Filter by delivery status
				</label>
				<select
					id="inbox-status"
					value={search.status ?? ""}
					onChange={(event) => {
						const value = event.target.value;
						onChange({
							status: isInboxStatus(value) ? value : undefined,
						});
					}}
					className="h-8 rounded-md border border-line-subtle bg-surface px-2 text-xs text-ink-secondary"
				>
					<option value="">All statuses</option>
					{STATUS_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>

				<label className="sr-only" htmlFor="inbox-source">
					Filter by event source
				</label>
				<select
					id="inbox-source"
					value={search.source ?? ""}
					onChange={(event) => {
						const value = event.target.value;
						onChange({
							source: INBOX_SOURCE_OPTIONS.some(
								(option) => option.value === value,
							)
								? value
								: undefined,
						});
					}}
					className="h-8 rounded-md border border-line-subtle bg-surface px-2 text-xs text-ink-secondary"
				>
					<option value="">All sources</option>
					{INBOX_SOURCE_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>

				<label className="sr-only" htmlFor="inbox-severity">
					Filter by severity
				</label>
				<select
					id="inbox-severity"
					value={search.severity ?? ""}
					onChange={(event) => {
						const value = event.target.value;
						onChange({
							severity: isInboxSeverity(value) ? value : undefined,
						});
					}}
					className="h-8 rounded-md border border-line-subtle bg-surface px-2 text-xs text-ink-secondary"
				>
					<option value="">All severities</option>
					{INBOX_SEVERITIES.map((severity) => (
						<option key={severity} value={severity}>
							{SEVERITY_LABELS[severity] ?? severity}
						</option>
					))}
				</select>
			</div>
			<div className="flex items-center gap-3 sm:ml-auto">
				<p className="text-xs text-ink-muted tabular-nums">
					{filtered ? `${count} matching` : `${count} delivered`}
				</p>
				{filtered ? (
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onClick={() =>
							onChange({
								status: undefined,
								source: undefined,
								severity: undefined,
							})
						}
					>
						Clear
					</Button>
				) : null}
			</div>
		</div>
	);
}

/** One bounded delivery table with client paging over the loaded window. */
export function InboxTable({
	items,
	page,
	onPageChange,
}: {
	items: readonly InboxItem[];
	page: number;
	onPageChange: (page: number) => void;
}) {
	const paged = useClientPagination({
		items,
		pageSize: INBOX_PAGE_SIZE,
		page,
		onPageChange,
	});

	return (
		<DataTable
			caption="Event deliveries for the active organization, newest first: source, event kind, severity, bounded signal title, repository, matched status and task."
			columns={COLUMNS}
			isEmpty={paged.pageItems.length === 0}
			empty="No deliveries match the active filters."
			pagination={
				<Pagination
					page={paged.page}
					pageCount={paged.pageCount}
					onPageChange={onPageChange}
					label="Inbox pages"
				/>
			}
			footer={
				<p className="text-[11px] text-ink-muted">
					Showing the newest {items.length} deliveries. The raw provider payload
					is never stored or displayed.
				</p>
			}
		>
			{paged.pageItems.map((item) => (
				<TableRow key={item.id} className="border-line-subtle">
					<TableCell className="py-2 text-xs text-ink-secondary whitespace-nowrap">
						<RelativeTime value={item.receivedAt} />
					</TableCell>
					<TableCell className="py-2 text-xs text-ink-secondary">
						{item.sourceLabel}
					</TableCell>
					<TableCell className="py-2">
						<span className="font-mono text-[11px] text-ink">
							{item.eventKind}
						</span>
						<p className="text-[10px] text-ink-muted">{item.source}</p>
					</TableCell>
					<TableCell className="py-2 text-xs text-ink-secondary">
						{item.severityLabel}
					</TableCell>
					<TableCell className="max-w-[420px] py-2">
						<p className="truncate text-xs text-ink">
							{item.title || "Untitled signal"}
						</p>
						{item.summary ? (
							<p className="truncate text-[10px] text-ink-muted">
								{item.summary}
							</p>
						) : null}
						{item.links[0] ? (
							<a
								href={item.links[0].url}
								target="_blank"
								rel="noreferrer"
								className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-brand hover:underline"
							>
								{item.links[0].label}
								<ExternalIcon size={10} />
							</a>
						) : null}
					</TableCell>
					<TableCell className="py-2 text-xs text-ink-secondary">
						{item.repository ?? (
							<span className="text-ink-muted">Unmapped</span>
						)}
					</TableCell>
					<TableCell className="py-2">
						<StatusBadge status={item.status} label={item.statusLabel} />
						{item.reasonLabel ? (
							<p className="mt-0.5 text-[10px] text-ink-muted">
								{item.reasonLabel}
							</p>
						) : null}
					</TableCell>
					<TableCell className="py-2 text-xs">
						{item.taskId ? (
							<Link
								to="/runs/$taskId"
								params={{ taskId: item.taskId }}
								className="text-brand hover:underline"
							>
								Open run
							</Link>
						) : (
							<span className="text-ink-muted">—</span>
						)}
					</TableCell>
				</TableRow>
			))}
		</DataTable>
	);
}

/**
 * The empty state for an organization that has never received a delivery:
 * explains how events become tasks and points at the integrations surface.
 */
export function InboxEmptyState() {
	return (
		<EmptyRow
			title="No event deliveries yet"
			description="A delivery appears here after a source posts a signed event and Isolate verifies it. If a trigger rule matches, Isolate records the delivery and creates one task; a duplicate is recorded as deduplicated and creates no second task."
			action={
				<Button asChild variant="outline" size="sm">
					<Link to="/integrations" search={{ tab: "catalog" }}>
						<InboxIcon size={14} />
						Connect a source
					</Link>
				</Button>
			}
		/>
	);
}

/** Loading placeholder for the route; same table rhythm, no data. */
export function InboxSkeleton() {
	return (
		<div className="flex flex-col gap-6" aria-busy="true">
			<div className="space-y-2 border-b border-line-subtle pb-6">
				<div className="h-[26px] w-28 rounded bg-elevated/60" />
				<div className="h-4 w-full max-w-xl rounded bg-elevated/30" />
			</div>
			<div className="h-10 rounded border-y border-line-subtle bg-elevated/20" />
			{["one", "two", "three", "four", "five", "six"].map((row) => (
				<div
					key={row}
					className="h-12 border-b border-line-subtle bg-elevated/15"
				/>
			))}
		</div>
	);
}
