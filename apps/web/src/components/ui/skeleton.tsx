import { cn } from '@/lib/cn';

/**
 * A loading placeholder shaped like the content it stands in for.
 *
 * Skeletons over spinners, per the Frontend Design Standard: a spinner says
 * "something is happening", a skeleton says "a table with four columns is
 * about to be here", which is the difference between waiting and being
 * disoriented.
 *
 * Promoted from three near-identical local copies — app-shell, the dashboard
 * panel, and the route-level loading file all grew their own.
 */
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  /** For widths that vary per row — a uniform stack reads as a loading GIF. */
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn('bg-surface-inset animate-pulse rounded-md', className)}
      style={style}
      aria-hidden="true"
    />
  );
}

/**
 * Wraps a group of skeletons with the announcement a screen reader needs.
 *
 * The individual bars are `aria-hidden`, so without this a non-visual user gets
 * silence while the page loads.
 */
export function SkeletonRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className} aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Row placeholder matching the documents table layout. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-px">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-3">
          <Skeleton className="size-9 shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {/* Varying widths — uniform bars read as a loading GIF rather than
                as the shape of real content. */}
            <Skeleton className="h-3.5" style={{ width: `${38 + ((index * 13) % 34)}%` }} />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton className="hidden h-3 w-16 sm:block" />
          <Skeleton className="hidden h-3 w-20 md:block" />
        </div>
      ))}
    </div>
  );
}
