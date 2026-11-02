import { cn } from "@/lib/utils";
import type { IntegrationCapabilities } from "../catalog";

const CAPABILITIES = [
	{ key: "eventSource", label: "Event source" },
	{ key: "context", label: "Context" },
	{ key: "actions", label: "Actions" },
] as const;

/**
 * The three capabilities are always shown together and never merged into one
 * "connected" claim. An unavailable capability is written, not greyed alone.
 */
export function CapabilityBadges({
	capabilities,
	className,
}: {
	capabilities: IntegrationCapabilities;
	className?: string;
}) {
	return (
		<ul
			aria-label="Capabilities"
			className={cn("flex flex-wrap items-center gap-1.5", className)}
		>
			{CAPABILITIES.map((entry) => {
				const available = capabilities[entry.key];
				return (
					<li
						key={entry.key}
						data-capability={entry.key}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px]",
							available
								? "border-line text-ink-secondary"
								: "border-line-subtle text-ink-muted/70",
						)}
					>
						<span
							aria-hidden="true"
							className={cn(
								"size-1 rounded-full",
								available ? "bg-brand" : "bg-ink-muted/40",
							)}
						/>
						{entry.label}
						<span className="sr-only">
							{available ? ": available" : ": not supported"}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
