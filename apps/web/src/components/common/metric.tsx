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
			<span className="truncate text-[11px] text-ink-muted">{label}</span>
			<span
				className={cn(
					"flex items-baseline gap-1 text-[26px] font-medium leading-none tracking-[-0.02em] tabular-nums",
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
				<span className="truncate text-[11px] text-ink-muted">{hint}</span>
			) : null}
		</div>
	);
}

export function MetricStrip({
	children,
	columns = 4,
	variant = "card",
	className,
}: {
	children: ReactNode;
	columns?: 2 | 3 | 4;
	variant?: "card" | "bare";
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid",
				columns === 2 && "sm:grid-cols-2",
				columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
				columns === 4 && "sm:grid-cols-2 lg:grid-cols-4",
				variant === "card"
					? "overflow-hidden rounded-lg border border-line-subtle bg-surface/50"
					: "border-y border-line-subtle",
				"[&>*+*]:border-t [&>*+*]:border-line-subtle sm:[&>*+*]:border-t-0 sm:[&>*+*]:border-l",
				variant === "bare" && "[&>*]:px-0 [&>*+*]:pl-5 [&>*]:py-4",
				className,
			)}
		>
			{children}
		</div>
	);
}
