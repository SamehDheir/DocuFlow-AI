import { Skeleton, SkeletonRegion, SkeletonRows } from '@/components/ui/skeleton';

/**
 * Loading state for the document browser.
 *
 * Its own file rather than the group's generic one because this page is the
 * only two-column layout in the app: the folder sidebar appears at `lg`, and a
 * skeleton that omits it would let the table settle at full width and then jump
 * inward when the real page lands. Holding the exact grid is the point.
 *
 * `SkeletonRows` is the same component the live list uses for its in-page
 * loading state, so the wait looks identical whether it started before the route
 * resolved or after.
 */
export default function Loading() {
  return (
    <SkeletonRegion label="Loading" shimmer className="flex flex-col gap-8">
      <div>
        <Skeleton className="h-3 w-24 rounded" />
        <Skeleton className="mt-2 h-9 w-56 max-w-full rounded-lg" />
        <Skeleton className="mt-3 h-4 w-80 max-w-full rounded" />
      </div>

      {/* Toolbar: the search field takes the slack, the actions keep their
          widths — matching `flex-wrap items-end gap-3` on the real page. */}
      <div className="flex flex-wrap items-end gap-3">
        <Skeleton className="h-11 min-w-52 flex-1 rounded-lg" />
        <Skeleton className="h-11 w-24 rounded-lg lg:hidden" />
        <Skeleton className="h-11 w-24 rounded-lg" />
        <Skeleton className="h-11 w-28 rounded-lg" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
        {/* Folder tree. Hidden below lg exactly as the real sidebar is, so the
            drawer-backed layout at tablet width is not promised a column that
            never arrives. */}
        <aside className="hidden flex-col gap-1.5 lg:flex">
          <Skeleton className="h-8 w-full rounded-md" />
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton
              key={index}
              className="h-8 rounded-md"
              style={{ width: `${72 + ((index * 11) % 26)}%` }}
            />
          ))}
        </aside>

        <section className="min-w-0">
          <div className="border-border bg-surface overflow-hidden rounded-xl border">
            {/* Column headings, hidden where the columns themselves are. */}
            <div className="border-border hidden items-center gap-4 border-b px-4 py-2 sm:flex">
              <span className="size-9 shrink-0" aria-hidden="true" />
              <Skeleton className="h-2.5 w-16 flex-1 rounded" />
              <Skeleton className="h-2.5 w-10 rounded" />
              <Skeleton className="hidden h-2.5 w-16 rounded md:block" />
              <span className="size-8 shrink-0" aria-hidden="true" />
            </div>

            <SkeletonRows />
          </div>
        </section>
      </div>
    </SkeletonRegion>
  );
}
