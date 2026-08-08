import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';

/**
 * Route-level loading for one document.
 *
 * Holds the same two-column grid the real page settles into, so the details
 * panel does not appear from nowhere after the main column has already drawn at
 * full width. The view has its own matching skeleton for the data fetch that
 * follows — this one covers the navigation, that one covers the request.
 */
export default function Loading() {
  return (
    <SkeletonRegion label="Loading" shimmer className="flex flex-col gap-8">
      <div>
        <Skeleton className="h-3 w-32 rounded" />
        <Skeleton className="mt-2 h-9 w-72 max-w-full rounded-lg" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0">
          {/* Tab strip, then the panel it reveals. */}
          <div className="mb-4 flex gap-2">
            {[16, 10, 14, 12].map((width, index) => (
              <Skeleton key={index} className="h-8 rounded-md" style={{ width: `${width}%` }} />
            ))}
          </div>
          <Skeleton className="h-[62dvh] w-full rounded-lg" />
        </section>

        <aside className="min-w-0">
          <div className="border-border bg-surface flex flex-col gap-4 rounded-xl border p-5">
            <Skeleton className="h-4 w-20 rounded" />
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div key={index} className="flex flex-col gap-1.5">
                <Skeleton className="h-2.5 w-16 rounded" />
                <Skeleton className="h-4 w-32 rounded" />
              </div>
            ))}
          </div>
        </aside>
      </div>
    </SkeletonRegion>
  );
}
