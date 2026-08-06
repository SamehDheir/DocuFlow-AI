'use client';

import { useId, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * A labelled native select.
 *
 * Deliberately native rather than a custom listbox. A hand-built dropdown has
 * to re-implement typeahead, keyboard selection, mobile pickers and screen
 * reader semantics, and usually gets one of them wrong; `<select>` already has
 * all of it, and on a phone it opens the platform picker. Only the chrome is
 * styled.
 *
 * Extracted from the filter markup the activity page had inline, so the search
 * and approvals filters inherit the same control instead of a third copy.
 */
export function Select({
  label,
  hint,
  children,
  className,
  id,
  ...props
}: ComponentPropsWithoutRef<'select'> & {
  label: string;
  hint?: string;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-text-muted text-xs font-medium">
        {label}
      </label>

      <div className="relative">
        <select
          {...props}
          id={fieldId}
          aria-describedby={hint ? hintId : undefined}
          className={cn(
            'border-border bg-surface text-text h-11 w-full rounded-lg border',
            // Extra inline-end padding leaves room for the chevron. Logical
            // properties, so it mirrors in Arabic rather than colliding.
            'ps-3 pe-9 text-sm',
            'focus-visible:ring-focus focus-visible:ring-2 focus-visible:outline-none',
            // Hides the platform arrow so the one below is the only one drawn.
            'appearance-none',
            className,
          )}
        >
          {children}
        </select>

        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="text-text-subtle pointer-events-none absolute inset-e-3 top-1/2 size-3 -translate-y-1/2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
        </svg>
      </div>

      {hint ? (
        <p id={hintId} className="text-text-subtle text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
