import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';

/**
 * Loading state for the signed-in pages — search, approvals, trash, activity.
 *
 * It renders *inside* AppShell rather than replacing it: `loading.tsx` wraps the
 * page and any layout below it, never the layout in its own segment. So the
 * header, navigation, bell and account menu stay put and stay interactive while
 * this stands in for the content, which is the whole reason to have it — a
 * loading screen that blanks the chrome makes the app look like it restarted.
 *
 * The shape is the one those four pages share: a title block, one control, then
 * a column of cards. Dashboard and documents are different enough to have their
 * own, alongside this file.
 *
 * A server component with no props: `loading.tsx` receives no params, so it
 * cannot reach the dictionary and deliberately holds no translatable text. The
 * region is announced as busy instead.
 */
export default function Loading() {
  return (
    <SkeletonRegion label="Loading" shimmer className="flex flex-col gap-8">
      {/* Title block — eyebrow, display heading, standfirst. */}
      <div>
        <Skeleton className="h-3 w-24 rounded" />
        <Skeleton className="mt-2 h-9 w-64 max-w-full rounded-lg" />
        <Skeleton className="mt-3 h-4 w-96 max-w-full rounded" />
      </div>

      {/* The single control each of these pages carries: a search field, or a
          row of tabs. One tall bar stands in for either. */}
      <Skeleton className="h-11 w-full rounded-lg" />

      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="border-border rounded-xl border p-4">
            <div className="flex items-center gap-2">
              {/* Varying widths — a stack of identical bars reads as a loading
                  GIF rather than as the shape of real content. */}
              <Skeleton className="h-4 rounded" style={{ width: `${34 + ((index * 17) % 30)}%` }} />
              <Skeleton className="h-4 w-16 shrink-0 rounded-full" />
              <Skeleton className="ms-auto h-3 w-14 shrink-0 rounded" />
            </div>

            <Skeleton className="mt-3 h-3 w-full rounded" />
            <Skeleton className="mt-2 h-3 w-4/5 rounded" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
