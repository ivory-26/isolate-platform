import { PageContainer } from "@/components/common/page-container";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Layout-matched skeleton so the first paint does not shift: the header band,
 * the compact metric strip and five hairline sections mirror the loaded Home.
 */
export function OverviewSkeleton() {
	return (
		<PageContainer>
			<div aria-busy="true" aria-live="polite" className="flex flex-col gap-8">
				<span className="sr-only">Loading home</span>
				<div className="flex flex-col gap-5 border-b border-line-subtle pb-6 md:flex-row md:items-end md:justify-between">
					<div className="min-w-0 space-y-2">
						<Skeleton className="h-[26px] w-32" />
						<Skeleton className="h-4 w-full max-w-xl" />
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Skeleton className="h-8 w-32" />
						<Skeleton className="h-8 w-28" />
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
				{["needs-you", "running", "inbox", "sources"].map((key) => (
					<div key={key} className="space-y-3">
						<div className="space-y-2">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-3 w-full max-w-md" />
						</div>
						<div className="divide-y divide-line-subtle border-y border-line-subtle">
							{["one", "two", "three"].map((row) => (
								<Skeleton key={`${key}-${row}`} className="h-11 w-full" />
							))}
						</div>
					</div>
				))}
			</div>
		</PageContainer>
	);
}
