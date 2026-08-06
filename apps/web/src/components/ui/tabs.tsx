'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useRef } from 'react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

/**
 * A tab strip following the WAI-ARIA tabs pattern.
 *
 * Roving tabindex, not a row of ordinary buttons: only the selected tab is
 * reachable with Tab and the rest with the arrow keys. That is what a screen
 * reader announces for `role="tablist"`, and it stops a five-tab strip costing
 * five Tab presses to step past.
 *
 * Arrow keys wrap; Home and End jump to the ends. Direction is read from the
 * live computed `dir`, so in Arabic the left arrow moves the way it looks.
 *
 * `idBase` is supplied by the caller — from one `useId()` shared with the
 * panels — because `aria-controls` here and `aria-labelledby` there have to
 * agree, and a hook called separately in each component cannot agree.
 */
export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** A count or status marker rendered after the label. */
  badge?: React.ReactNode;
  disabled?: boolean;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idBase,
  className,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the tablist for assistive technology. */
  label: string;
  idBase: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const refs = useRef(new Map<T, HTMLButtonElement | null>());

  const enabled = items.filter((item) => !item.disabled);

  const focus = (next: TabItem<T> | undefined) => {
    if (!next) {
      return;
    }

    onChange(next.value);
    refs.current.get(next.value)?.focus();
  };

  const move = (delta: number) => {
    const index = enabled.findIndex((item) => item.value === value);
    // Wraps both ways, so Right on the last tab returns to the first.
    focus(enabled[(index + delta + enabled.length) % enabled.length]);
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('border-border flex gap-1 border-b', className)}
      onKeyDown={(event) => {
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';

        switch (event.key) {
          case 'ArrowRight':
            event.preventDefault();
            move(rtl ? -1 : 1);
            break;
          case 'ArrowLeft':
            event.preventDefault();
            move(rtl ? 1 : -1);
            break;
          case 'Home':
            event.preventDefault();
            focus(enabled[0]);
            break;
          case 'End':
            event.preventDefault();
            focus(enabled.at(-1));
            break;
          default:
            break;
        }
      }}
    >
      {items.map((item) => {
        const selected = item.value === value;

        return (
          <button
            key={item.value}
            ref={(node) => {
              refs.current.set(item.value, node);
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${item.value}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${item.value}`}
            // The roving part: unselected tabs are skipped by Tab.
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={cn(
              'relative -mb-px flex items-center gap-2 rounded-t-md px-3 py-2',
              'text-sm font-medium transition-colors',
              'focus-visible:ring-focus focus-visible:ring-2 focus-visible:outline-none',
              item.disabled
                ? 'text-text-subtle cursor-not-allowed'
                : selected
                  ? 'text-text'
                  : 'text-text-muted hover:text-text',
            )}
          >
            {item.label}
            {item.badge}
            {selected ? (
              /**
               * One shared layoutId slides the underline between tabs rather
               * than cross-fading two of them — the same treatment the primary
               * nav uses, so the app moves consistently.
               */
              <motion.span
                layoutId={`${idBase}-tab-underline`}
                className="bg-accent absolute inset-x-0 -bottom-px h-0.5 rounded-full"
                transition={
                  reduced ? { duration: 0 } : { duration: DURATION.base, ease: EASE.outExpo }
                }
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The panel belonging to one tab. Rendered only while its tab is selected. */
export function TabPanel<T extends string>({
  value,
  selected,
  idBase,
  children,
  className,
}: {
  value: T;
  selected: T;
  /** The same `idBase` the strip was given. */
  idBase: string;
  children: React.ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();

  if (value !== selected) {
    return null;
  }

  return (
    <motion.div
      role="tabpanel"
      id={`${idBase}-panel-${value}`}
      aria-labelledby={`${idBase}-tab-${value}`}
      // Panels hold scrollable text, so the panel itself has to be focusable
      // for a keyboard user to scroll it.
      tabIndex={0}
      className={cn(
        'focus-visible:ring-focus rounded-md focus-visible:ring-2 focus-visible:outline-none',
        className,
      )}
      initial={reduced ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
    >
      {children}
    </motion.div>
  );
}
