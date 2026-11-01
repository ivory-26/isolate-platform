import { cn } from "@/lib/utils";

export function BrandMark({
	className,
	markClassName,
}: {
	className?: string;
	markClassName?: string;
}) {
	return (
		<span
			className={cn(
				"flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-elevated",
				className,
			)}
			aria-hidden="true"
		>
			<svg
				viewBox="0 0 24 24"
				className={cn("size-5", markClassName)}
				fill="none"
			>
				<title>Isolate</title>
				<path
					d="M8 4H5v16h3M16 4h3v16h-3"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					className="text-ink-secondary"
				/>
				<circle
					cx="12"
					cy="12"
					r="2.5"
					stroke="currentColor"
					strokeWidth="1.5"
					className="text-brand"
				/>
			</svg>
		</span>
	);
}
