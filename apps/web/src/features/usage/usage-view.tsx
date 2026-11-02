import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Metric } from "@/components/common/metric";
import {
	Pagination,
	useClientPagination,
} from "@/components/common/pagination";
import { DataTable } from "@/components/console/data-table";
import { MetricBand } from "@/components/console/metric-band";
import { ConsoleSection } from "@/components/console/section";
import { Area } from "@/components/dither-kit/area";
import { AreaChart } from "@/components/dither-kit/area-chart";
import { Bar } from "@/components/dither-kit/bar";
import { BarChart } from "@/components/dither-kit/bar-chart";
import { Grid } from "@/components/dither-kit/grid";
import { Sparkline } from "@/components/dither-kit/sparkline";
import { Tooltip as ChartTooltip } from "@/components/dither-kit/tooltip";
import { XAxis } from "@/components/dither-kit/x-axis";
import { YAxis } from "@/components/dither-kit/y-axis";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatDate, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatUsd } from "./aggregate";
import {
	USAGE_PAGE_SIZE,
	USAGE_TIME_ZONE,
	type UsagePeriod,
	type UsageReadModel,
	usagePeriods,
	usageSearchForPeriod,
} from "./contracts";

const TOKEN_CONFIG = {
	tokens: { label: "Total tokens", color: "blue" as const },
};
const COST_CONFIG = {
	cost: { label: "Recorded cost (USD)", color: "blue" as const },
};

const SKELETON_CELLS = ["prompt", "completion", "sandbox", "cost", "tasks"];

function dayLabel(day: string): string {
	return day.slice(5);
}

export function UsagePeriodSelector({ period }: { period: UsagePeriod }) {
	return (
		<nav aria-label="Usage period" className="flex items-center gap-1">
			{usagePeriods.map((option) => {
				const active = option === period;
				return (
					<Button
						key={option}
						asChild
						size="xs"
						variant={active ? "secondary" : "ghost"}
						className={cn(!active && "text-ink-muted hover:text-ink")}
					>
						<Link
							to="/usage"
							search={usageSearchForPeriod(option)}
							aria-current={active ? "page" : undefined}
						>
							{option} days
						</Link>
					</Button>
				);
			})}
		</nav>
	);
}

function costHint(model: UsageReadModel): string {
	if (model.totals.costUsd === null) return "No trusted price recorded";
	if (model.totals.costCoverage === "partial") {
		return "Partial — some rows had no trusted price";
	}
	return "Measured · UTC";
}

export function UsageMetrics({ model }: { model: UsageReadModel }) {
	const sandboxSeries = useMemo(
		() => model.days.map((day) => day.sandboxSeconds),
		[model.days],
	);
	return (
		<MetricBand columns={5}>
			<Metric
				label="Prompt tokens"
				value={model.totals.promptTokens}
				format={{ notation: "compact", maximumFractionDigits: 1 }}
				hint="Measured"
			/>
			<Metric
				label="Completion tokens"
				value={model.totals.completionTokens}
				format={{ notation: "compact", maximumFractionDigits: 1 }}
				hint="Measured"
			/>
			<div className="flex flex-col">
				<Metric
					label="Sandbox seconds"
					value={model.totals.sandboxSeconds}
					suffix={<span className="text-base text-ink-muted">s</span>}
					hint="Measured sandbox time"
				/>
				<div className="px-5 pb-4" aria-hidden="true">
					<Sparkline
						data={sandboxSeries}
						color="blue"
						variant="gradient"
						className="h-7 w-full"
					/>
				</div>
			</div>
			<Metric
				label="Recorded cost"
				value={formatUsd(model.totals.costUsd)}
				hint={costHint(model)}
				tone={model.totals.costCoverage === "partial" ? "warning" : "default"}
			/>
			<Metric
				label="Tasks with usage"
				value={model.totals.tasks}
				hint="Distinct tasks in this period"
			/>
		</MetricBand>
	);
}

export function UsageCharts({ model }: { model: UsageReadModel }) {
	const tokenRows = useMemo(
		() =>
			model.days.map((day) => ({
				label: dayLabel(day.day),
				day: day.day,
				tokens: day.totalTokens,
			})),
		[model.days],
	);
	const costRows = useMemo(
		() =>
			model.days.map((day) => ({
				label: dayLabel(day.day),
				day: day.day,
				cost: day.costUsd === null ? 0 : Number(day.costUsd),
			})),
		[model.days],
	);
	const range = `${formatDate(model.since)} – ${formatDate(
		new Date(new Date(model.until).getTime() - 1),
	)}`;

	return (
		<div className="grid gap-8 lg:grid-cols-2 lg:gap-0 lg:divide-x lg:divide-line-subtle">
			<ConsoleSection
				id="usage-token-trend"
				title="Token trend"
				description={`Total tokens per day · ${range} · ${USAGE_TIME_ZONE}`}
				className="lg:pr-6"
			>
				<figure aria-labelledby="usage-token-chart-caption">
					<figcaption id="usage-token-chart-caption" className="sr-only">
						Daily total model tokens, measured in UTC. The daily breakdown table
						below lists the same values.
					</figcaption>
					<div className="h-56 w-full" aria-hidden="true">
						<AreaChart
							data={tokenRows}
							config={TOKEN_CONFIG}
							margins={{ top: 12, right: 10, bottom: 24, left: 44 }}
							className="h-full w-full"
						>
							<Grid />
							<XAxis dataKey="label" maxTicks={6} />
							<YAxis tickFormatter={(value) => formatTokens(value)} />
							<Area dataKey="tokens" variant="gradient" />
							<ChartTooltip
								labelKey="label"
								valueFormatter={(value) => `${formatTokens(value)} tokens`}
							/>
						</AreaChart>
					</div>
					<p className="mt-2 text-[11px] text-ink-muted">
						Visual trend; the accessible values are in the daily breakdown
						table.
					</p>
				</figure>
			</ConsoleSection>

			<ConsoleSection
				id="usage-cost-trend"
				title="Recorded cost"
				description={`Known prices only · ${range} · ${USAGE_TIME_ZONE}`}
				className="lg:pl-6"
			>
				{model.totals.costUsd === null ? (
					<div className="flex min-h-56 items-center">
						<div className="max-w-sm space-y-1">
							<p className="text-sm text-ink-secondary">
								No trusted price was recorded for this period.
							</p>
							<p className="text-xs leading-5 text-ink-muted">
								Rows without a configured price are never estimated or counted
								as zero.
							</p>
						</div>
					</div>
				) : (
					<figure aria-labelledby="usage-cost-chart-caption">
						<figcaption id="usage-cost-chart-caption" className="sr-only">
							Daily recorded cost in USD for rows with a trusted price. Days
							without a price render as zero-height and show a dash in the
							table.
						</figcaption>
						<div className="h-56 w-full" aria-hidden="true">
							<BarChart
								data={costRows}
								config={COST_CONFIG}
								margins={{ top: 12, right: 10, bottom: 24, left: 48 }}
								className="h-full w-full"
							>
								<Grid />
								<XAxis dataKey="label" maxTicks={6} />
								<YAxis tickFormatter={(value) => formatUsd(value)} />
								<Bar dataKey="cost" variant="gradient" />
								<ChartTooltip
									labelKey="label"
									valueFormatter={(value) => formatUsd(value)}
								/>
							</BarChart>
						</div>
						<p className="mt-2 text-[11px] text-ink-muted">
							{model.totals.costCoverage === "partial"
								? "Partial: at least one row had no trusted price, so the total understates full spend."
								: "Every usage row in this period carried a trusted price."}
						</p>
					</figure>
				)}
			</ConsoleSection>
		</div>
	);
}

const USAGE_TABLE_COLUMNS = [
	{ key: "day", header: "Day (UTC)" },
	{ key: "prompt", header: "Prompt tokens", align: "right" as const },
	{ key: "completion", header: "Completion tokens", align: "right" as const },
	{ key: "total", header: "Total tokens", align: "right" as const },
	{ key: "sandbox", header: "Sandbox seconds", align: "right" as const },
	{ key: "cost", header: "Recorded cost", align: "right" as const },
];

export function UsageTable({
	model,
	page,
	onPageChange,
}: {
	model: UsageReadModel;
	page: number;
	onPageChange: (page: number) => void;
}) {
	// Newest day first; the table paginates the reversed list, not the chart rows.
	const days = useMemo(() => [...model.days].reverse(), [model.days]);
	const paged = useClientPagination({
		items: days,
		pageSize: USAGE_PAGE_SIZE,
		page,
		onPageChange,
	});

	return (
		<ConsoleSection
			id="usage-daily-breakdown"
			title="Daily breakdown"
			description={`Measured usage per UTC day for the last ${model.period} days. A dash means no trusted price.`}
		>
			<DataTable
				caption="Daily measured usage for the active organization: prompt and completion tokens, sandbox seconds and recorded cost in USD, newest first. Times are UTC."
				columns={USAGE_TABLE_COLUMNS}
				isEmpty={paged.pageItems.length === 0}
				empty="No measured usage rows in this period."
				pagination={
					<Pagination
						page={paged.page}
						pageCount={paged.pageCount}
						onPageChange={onPageChange}
						label="Daily breakdown pages"
					/>
				}
				footer={
					<p className="text-[11px] text-ink-muted">
						* Partial cost: at least one row that day had no trusted price.
						Sandbox seconds come from measured task attempts for tasks created
						in the window.
					</p>
				}
			>
				{paged.pageItems.map((day) => (
					<TableRow key={day.day} className="h-11 border-line-subtle">
						<TableCell className="font-mono text-xs text-ink-secondary">
							{day.day}
						</TableCell>
						<TableCell className="text-right font-mono text-xs tabular-nums">
							{formatTokens(day.promptTokens)}
						</TableCell>
						<TableCell className="text-right font-mono text-xs tabular-nums">
							{formatTokens(day.completionTokens)}
						</TableCell>
						<TableCell className="text-right font-mono text-xs tabular-nums text-ink">
							{formatTokens(day.totalTokens)}
						</TableCell>
						<TableCell className="text-right font-mono text-xs tabular-nums">
							{Math.round(day.sandboxSeconds)}
						</TableCell>
						<TableCell className="text-right font-mono text-xs tabular-nums">
							{formatUsd(day.costUsd)}
							{day.costCoverage === "partial" ? (
								<span
									className="ml-1 text-orange"
									title="Some rows this day had no trusted price"
								>
									*
								</span>
							) : null}
						</TableCell>
					</TableRow>
				))}
			</DataTable>
		</ConsoleSection>
	);
}

export function UsageSkeleton() {
	return (
		<div className="flex flex-col gap-6">
			<div className="space-y-2 border-b border-line-subtle pb-6">
				<Skeleton className="h-7 w-40" />
				<Skeleton className="h-4 w-full max-w-xl" />
			</div>
			<div className="grid divide-y divide-line-subtle border-y border-line-subtle lg:grid-cols-5 lg:divide-x lg:divide-y-0">
				{SKELETON_CELLS.map((cell) => (
					<Skeleton key={cell} className="h-20 w-full" />
				))}
			</div>
			<div className="grid gap-8 lg:grid-cols-2">
				<Skeleton className="h-64 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
			<Skeleton className="h-72 w-full" />
		</div>
	);
}
