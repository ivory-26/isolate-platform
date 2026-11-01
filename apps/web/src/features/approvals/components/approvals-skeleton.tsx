import { PageContainer } from "@/components/common/page-container";
import { Skeleton } from "@/components/ui/skeleton";

export function ApprovalsSkeleton() {
	return (
		<PageContainer>
			<div aria-busy="true" aria-live="polite" className="flex flex-col gap-6">
				<span className="sr-only">Loading approvals</span>
				<div className="space-y-3 border-b border-line-subtle pb-6">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-7 w-40" />
					<Skeleton className="h-4 w-full max-w-xl" />
				</div>
				<div className="grid gap-3 lg:grid-cols-2">
					<Skeleton className="h-44 w-full rounded-lg" />
					<Skeleton className="h-44 w-full rounded-lg" />
					<Skeleton className="h-44 w-full rounded-lg" />
					<Skeleton className="h-44 w-full rounded-lg" />
				</div>
				<Skeleton className="h-56 w-full rounded-lg" />
			</div>
		</PageContainer>
	);
}
