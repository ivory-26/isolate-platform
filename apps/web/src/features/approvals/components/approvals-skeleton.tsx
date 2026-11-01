import { PageContainer } from "@/components/common/page-container";
import { Skeleton } from "@/components/ui/skeleton";

const SKELETON_ROWS = ["one", "two", "three", "four"];

export function ApprovalsSkeleton() {
	return (
		<PageContainer>
			<div aria-busy="true" aria-live="polite" className="flex flex-col gap-6">
				<span className="sr-only">Loading approvals</span>
				<div className="space-y-2 border-b border-line-subtle pb-6">
					<Skeleton className="h-7 w-40" />
					<Skeleton className="h-4 w-full max-w-xl" />
				</div>
				<div className="space-y-3">
					<Skeleton className="h-4 w-44" />
					<div className="divide-y divide-line-subtle border-y border-line-subtle">
						{SKELETON_ROWS.map((row) => (
							<div key={row} className="flex items-center justify-between py-4">
								<div className="w-full max-w-md space-y-2">
									<Skeleton className="h-4 w-1/3" />
									<Skeleton className="h-3 w-full" />
									<Skeleton className="h-3 w-2/3" />
								</div>
								<Skeleton className="h-8 w-28" />
							</div>
						))}
					</div>
				</div>
			</div>
		</PageContainer>
	);
}
