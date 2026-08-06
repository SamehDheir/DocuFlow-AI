import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';

/**
 * Loading state for the dashboard.
 *
 * The page landed on straight after sign-in, so it is the loading screen seen
 * most often and the one worth shaping precisely. Nothing here is generic: the
 * two tile grids keep their own column counts and their own breakpoints
 * (`sm:grid-cols-3` for the workspace facts, `sm:grid-cols-2 lg:grid-cols-4`
 * for the storage figures), because those are what decide the page's height at
 * each width. Get them wrong and the whole page below shifts when the numbers
 * arrive.
 */
export default function Loading() {
  return (
    <SkeletonRegion label="Loading" shimmer>
      <div>
        <Skeleton className="h-3 w-24 rounded" />
        <Skeleton className="mt-2 h-9 w-72 max-w-full rounded-lg" />
        <Skeleton className="mt-3 h-4 w-64 max-w-full rounded" />
      </div>

      {/* Workspace, role, permissions. */}
      <div className="mt-9 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="border-border bg-surface rounded-xl border px-5 py-4">
            <Skeleton className="h-2.5 w-20 rounded" />
            <Skeleton className="mt-2 h-5 w-32 max-w-full rounded" />
          </div>
        ))}
      </div>

      {/* Storage, documents, trashed, members. */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="border-border bg-surface rounded-xl border px-5 py-4">
            <Skeleton className="h-2.5 w-16 rounded" />
            <Skeleton className="mt-2 h-5 w-20 rounded" />
          </div>
        ))}
      </div>

      {/* Recent documents, then the activity trail — the same panel twice, as
          on the page itself. */}
      {[5, 4].map((rows, panel) => (
        <div
          key={panel}
          className="border-border bg-surface mt-4 overflow-hidden rounded-xl border"
        >
          <div className="border-border flex items-center justify-between gap-4 border-b px-5 py-3">
            <Skeleton className="h-3.5 w-32 rounded" />
            <Skeleton className="h-3 w-16 rounded" />
          </div>

          <div className="divide-border divide-y">
            {Array.from({ length: rows }, (_, index) => (
              <div key={index} className="flex items-center gap-3 px-5 py-3">
                <Skeleton className="size-8 shrink-0 rounded-md" />
                <Skeleton
                  className="h-3.5 min-w-0 flex-1 rounded"
                  style={{ maxWidth: `${44 + ((index * 13) % 32)}%` }}
                />
                <Skeleton className="h-3 w-12 shrink-0 rounded" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}
