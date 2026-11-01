import { useState } from "react";
import { toast } from "sonner";
import { CheckIcon, CopyIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyButton({
	value,
	label = "Copy",
	className,
}: {
	value: string;
	label?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			className={cn("text-ink-muted hover:text-ink", className)}
			aria-label={copied ? "Copied" : label}
			title={label}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(value);
					setCopied(true);
					toast.success("Copied to clipboard");
					window.setTimeout(() => setCopied(false), 1600);
				} catch {
					toast.error("Clipboard access is unavailable");
				}
			}}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
}
