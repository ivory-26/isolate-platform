import NumberFlow, { type Format } from "@number-flow/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONE = {
	default: "text-ink",
	brand: "text-brand",
	orange: "text-orange",
	success: "text-success",
	warning: "text-warning",
	danger: "text-danger",
	muted: "text-ink-muted",
} as const;

export function Metric({
	label,
	value,
	format,
	prefix,
	suffix,
	hint,
	tone = "default",
	className,
}: {
	label: ReactNode;
	value: number | string;
	format?: Format;
	prefix?: ReactNode;
	suffix?: ReactNode;
	hint?: ReactNode;
	tone?: keyof typeof TONE;
	className?: string;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-1 px-5 py-4", className)}>
			<span className="truncate text-xs font-medium text-ink-muted">
				{label}
			</span>
			<span
				className={cn(
					"flex items-baseline gap-1 text-2xl font-semibold tracking-tight tabular-nums",
					TONE[tone],
				)}
			>
				{prefix}
				{typeof value === "number" ? (
					<NumberFlow
						value={value}
						format={format}
						locales="en-US"
						respectMotionPreference
					/>
				) : (
					value
				)}
				{suffix}
			</span>
			{hint ? (
				<span className="truncate text-xs text-ink-muted">{hint}</span>
			) : null}
		</div>
	);
}

export function MetricStrip({
	children,
	columns = 4,
	className,
}: {
	children: ReactNode;
	columns?: 2 | 3 | 4;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid overflow-hidden rounded-lg border border-line-subtle bg-surface/50",
				columns === 2 && "sm:grid-cols-2",
				columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
				columns === 4 && "sm:grid-cols-2 lg:grid-cols-4",
				"[&>*+*]:border-t [&>*+*]:border-line-subtle sm:[&>*+*]:border-t-0 sm:[&>*+*]:border-l",
				className,
			)}
		>
			{children}
		</div>
	);
}
