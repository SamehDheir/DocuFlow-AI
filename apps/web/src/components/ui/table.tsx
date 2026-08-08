'use client';

import { cn } from '@/lib/cn';

/**
 * A real `<table>`, not a grid of divs.
 *
 * The document browser is tabular data — name, type, size, owner, date — and a
 * screen reader reading a div grid gets a wall of text with no column
 * relationships, no "column 3 of 6", and no way to jump by row. `role="grid"` on
 * divs can restore some of that by hand; the element already has all of it.
 *
 * Composable rather than a `<Table columns rows>` component, because the
 * documents view needs a checkbox column, a status chip, a menu and a truncating
 * name cell — the moment a data-driven table has to render four different cell
 * shapes it grows a render-prop per column and has bought nothing.
 */

/**
 * The horizontal scroll container. Not optional.
 *
 * A table is the one thing that reliably makes a page scroll sideways on a
 * phone, and the page body must never do that. This confines the overflow to
 * the table and makes it keyboard-reachable, since a scrollable region that
 * cannot be focused cannot be scrolled without a mouse.
 */
export function TableScroll({
  label,
  className,
  children,
}: {
  /** Names the scroll region — it is focusable, so it needs one. */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cn(
        'border-border bg-surface overflow-x-auto rounded-xl border',
        'focus-visible:outline-focus focus-visible:outline-2 focus-visible:-outline-offset-2',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Table({ className, children, ...props }: React.ComponentPropsWithoutRef<'table'>) {
  return (
    <table className={cn('w-full border-collapse text-sm', className)} {...props}>
      {children}
    </table>
  );
}

/**
 * Sticky by default: scrolling a thousand rows past a header that has scrolled
 * away leaves the reader guessing which column is which.
 */
export function TableHead({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <thead
      className={cn(
        'bg-surface-inset text-text-subtle sticky top-0 z-10',
        'text-2xs font-medium tracking-wide uppercase',
        className,
      )}
    >
      {children}
    </thead>
  );
}

export function TableBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <tbody className={cn('divide-border divide-y', className)}>{children}</tbody>;
}

export function TableRow({
  selected = false,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'tr'> & {
  /** Drives `aria-selected` as well as the fill — the two must not disagree. */
  selected?: boolean;
}) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={cn(
        'transition-colors duration-fast ease-out-quint',
        selected ? 'bg-accent-subtle' : 'hover:bg-surface-inset',
        className,
      )}
      {...props}
    >
      {children}
    </tr>
  );
}

/**
 * Logical, not physical — `end` is the right in English and the left in Arabic.
 *
 * The native `align` attribute is Omit-ed from both cell components below: it is
 * a deprecated presentational attribute typed as `"left" | "center" | …`, and
 * leaving it in the union means TypeScript reads `align="start"` as an attempt
 * to set it and rejects the value.
 */
type Align = 'start' | 'end' | 'center';

const ALIGN: Record<Align, string> = {
  start: 'text-start',
  end: 'text-end',
  center: 'text-center',
};

export function TableCell({
  align = 'start',
  className,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'td'>, 'align'> & { align?: Align }) {
  return (
    <td className={cn('px-4 py-2.5 align-middle', ALIGN[align], className)} {...props}>
      {children}
    </td>
  );
}

export type SortDirection = 'asc' | 'desc';

/**
 * A column heading, optionally sortable.
 *
 * `aria-sort` goes on the `<th>` and the control is a real button inside it —
 * putting the click handler on the cell itself would give a keyboard user no
 * way to reach it, which is the usual way sortable tables end up mouse-only.
 */
export function TableHeaderCell({
  align = 'start',
  sortable = false,
  direction,
  onSort,
  className,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'th'>, 'align' | 'onSort'> & {
  align?: Align;
  sortable?: boolean;
  /** Set only on the column currently sorted. */
  direction?: SortDirection;
  onSort?: () => void;
}) {
  return (
    <th
      scope="col"
      aria-sort={
        sortable
          ? direction === 'asc'
            ? 'ascending'
            : direction === 'desc'
              ? 'descending'
              : 'none'
          : undefined
      }
      className={cn('border-border border-b px-4 py-2.5 font-medium', ALIGN[align], className)}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm',
            'transition-colors duration-fast ease-out-quint',
            'hover:text-text focus-visible:outline-focus focus-visible:outline-2 focus-visible:outline-offset-2',
            direction && 'text-text',
          )}
        >
          {children}
          <SortGlyph direction={direction} />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

/**
 * Both arrows are always drawn, with the active one at full strength.
 *
 * A glyph that appears only on the sorted column gives no hint that the others
 * can be sorted at all, and swapping one arrow for another shifts the heading's
 * width by a pixel on every click.
 */
function SortGlyph({ direction }: { direction?: SortDirection }) {
  return (
    <svg viewBox="0 0 8 12" className="size-2.5 shrink-0" aria-hidden="true" fill="currentColor">
      <path d="M4 0 7 4H1Z" opacity={direction === 'asc' ? 1 : 0.3} />
      <path d="M4 12 1 8h6Z" opacity={direction === 'desc' ? 1 : 0.3} />
    </svg>
  );
}
