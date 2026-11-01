import { PageContainer } from "@/components/common/page-container";
import { Skeleton } from "@/components/ui/skeleton";

/** Layout-matched skeleton so the first paint does not shift. */
export function OverviewSkeleton() {
	return (
		<PageContainer>
			<div aria-busy="true" aria-live="polite" className="flex flex-col gap-6">
				<span className="sr-only">Loading overview</span>
				<div className="space-y-3 border-b border-line-subtle pb-6">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-7 w-48" />
					<Skeleton className="h-4 w-full max-w-xl" />
				</div>
				<div className="grid overflow-hidden rounded-lg border border-line-subtle bg-surface/50 sm:grid-cols-2 lg:grid-cols-4">
					{["a", "b", "c", "d"].map((key) => (
						<div key={key} className="space-y-2 px-5 py-4">
							<Skeleton className="h-3 w-24" />
							<Skeleton className="h-7 w-16" />
							<Skeleton className="h-3 w-32" />
						</div>
					))}
				</div>
				<div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
					<Skeleton className="h-80 w-full rounded-lg" />
					<Skeleton className="h-80 w-full rounded-lg" />
				</div>
				<div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
					<Skeleton className="h-64 w-full rounded-lg" />
					<Skeleton className="h-64 w-full rounded-lg" />
				</div>
			</div>
		</PageContainer>
	);
}
