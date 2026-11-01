import type { ComponentType, ReactNode } from "react";
import { type AppIconProps, InfoIcon, WarningIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "warning" | "danger";

const TONE: Record<Tone, { rule: string; text: string; icon: string }> = {
	neutral: {
		rule: "border-line-strong",
		text: "text-ink-secondary",
		icon: "text-ink-muted",
	},
	warning: {
		rule: "border-warning/60",
		text: "text-warning",
		icon: "text-warning",
	},
	danger: {
		rule: "border-danger/60",
		text: "text-danger",
		icon: "text-danger",
	},
};

/**
 * A quiet inline note: one rule on the left, no box. Used for unavailable,
 * stale and capability explanations that must stay visible but not shout.
 */
export function ConsoleNote({
	children,
	tone = "neutral",
	role,
	icon,
	className,
}: {
	children: ReactNode;
	tone?: Tone;
	role?: "status" | "alert" | "note";
	icon?: ComponentType<AppIconProps>;
	className?: string;
}) {
	const Glyph =
		icon ?? (tone === "warning" || tone === "danger" ? WarningIcon : InfoIcon);
	const palette = TONE[tone];
	return (
		<div
			role={role}
			className={cn(
				"flex items-start gap-2 border-l-2 py-2 pl-3 text-xs leading-5",
				palette.rule,
				palette.text,
				className,
			)}
		>
			<Glyph size={14} className={cn("mt-1 shrink-0", palette.icon)} />
			<div className="min-w-0">{children}</div>
		</div>
	);
}
