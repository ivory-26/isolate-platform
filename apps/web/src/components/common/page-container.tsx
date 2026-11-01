import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageContainer({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-5 py-6 lg:px-8 lg:py-8",
				className,
			)}
		>
			{children}
		</div>
	);
}
