'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useId, useRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

/**
 * A checkbox, built on the real input.
 *
 * The native control is present and focusable — only visually replaced — so
 * keyboard activation, form participation, and the semantics a screen reader
 * announces all come for free. A `role="checkbox"` div would have to
 * re-implement every one of those, and typically forgets Space.
 *
 * INDETERMINATE IS A DOM PROPERTY, NOT AN ATTRIBUTE. React has no `indeterminate`
 * prop and will not render one, so it has to be assigned to the node. This is
 * the whole reason the component holds a ref: a "select all" header box showing
 * a tick when only three of fifty rows are selected is a lie the user acts on.
 */
export function Checkbox({
  label,
  hideLabel = false,
  indeterminate = false,
  description,
  className,
  id: idProp,
  ...props
}: Omit<ComponentPropsWithoutRef<'input'>, 'type'> & {
  /** Always required. `hideLabel` hides it visually, never from assistive tech. */
  label: string;
  hideLabel?: boolean;
  indeterminate?: boolean;
  description?: string;
}) {
  const generated = useId();
  const id = idProp ?? generated;
  const descriptionId = `${id}-description`;
  const ref = useRef<HTMLInputElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  const checked = props.checked ?? props.defaultChecked ?? false;
  const marked = indeterminate || checked;

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
        <input
          {...props}
          ref={ref}
          id={id}
          type="checkbox"
          aria-describedby={description ? descriptionId : undefined}
          // Opacity rather than `hidden` or `sr-only`: the input keeps its box,
          // so it stays the click target over the whole control and Windows
          // High Contrast still paints the native indicator.
          className="peer absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />

        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none flex size-4.5 items-center justify-center rounded-[0.3rem] border',
            'transition-[background-color,border-color] duration-fast ease-out-quint',
            marked
              ? 'bg-accent border-accent text-accent-fg'
              : 'bg-surface border-border-strong peer-hover:border-text-subtle',
            'peer-focus-visible:outline-focus peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2',
            'peer-disabled:opacity-50',
          )}
        >
          {indeterminate ? (
            <motion.span
              // The mixed state is a dash, not a tick. A partially-selected page
              // that renders as fully ticked is the bug this component exists to
              // prevent.
              className="bg-accent-fg h-0.5 w-2.5 rounded-full"
              initial={reduced ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
            />
          ) : checked ? (
            <motion.svg viewBox="0 0 16 16" className="size-3" fill="none" aria-hidden="true">
              <motion.path
                d="M3.5 8.5 6.5 11.5 12.5 4.5"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                // The tick draws itself on. Reduced motion gets the finished
                // mark immediately rather than nothing at all.
                initial={reduced ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: DURATION.base, ease: EASE.outQuint }}
              />
            </motion.svg>
          ) : null}
        </span>
      </span>

      <span className={cn('min-w-0', hideLabel && 'sr-only')}>
        <label
          htmlFor={id}
          className={cn(
            'text-text block text-sm leading-5 select-none',
            props.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
          )}
        >
          {label}
        </label>

        {description ? (
          <span id={descriptionId} className="text-text-subtle mt-0.5 block text-xs">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}
