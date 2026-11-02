import { PageContainer } from "@/components/common/page-container";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Layout-matched skeleton so the first paint does not shift: the header band,
 * the bare metric strip (borders and cell padding) and the two-column section
 * rhythm mirror the loaded overview.
 */
export function OverviewSkeleton() {
	return (
		<PageContainer>
			<div aria-busy="true" aria-live="polite" className="flex flex-col gap-6">
				<span className="sr-only">Loading overview</span>
				<div className="flex flex-col gap-5 border-b border-line-subtle pb-6 md:flex-row md:items-end md:justify-between">
					<div className="min-w-0 space-y-2">
						<Skeleton className="h-[26px] w-44" />
						<Skeleton className="h-4 w-full max-w-xl" />
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Skeleton className="h-8 w-24" />
						<Skeleton className="h-8 w-24" />
					</div>
				</div>
				<div className="grid border-y border-line-subtle sm:grid-cols-2 lg:grid-cols-4">
					{["a", "b", "c", "d"].map((key) => (
						<div key={key} className="flex min-w-0 flex-col gap-1 px-5 py-4">
							<Skeleton className="h-3 w-24" />
							<Skeleton className="h-[26px] w-16" />
							<Skeleton className="h-3 w-32" />
						</div>
					))}
				</div>
				<div className="grid gap-10 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] xl:gap-8">
					<Skeleton className="h-80 w-full rounded-lg" />
					<Skeleton className="h-80 w-full rounded-lg" />
				</div>
				<div className="grid gap-10 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] xl:gap-8">
					<Skeleton className="h-64 w-full rounded-lg" />
					<Skeleton className="h-64 w-full rounded-lg" />
				</div>
			</div>
		</PageContainer>
	);
}
