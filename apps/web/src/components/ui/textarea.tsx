'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';
import { collapse, DURATION, EASE } from '@/lib/motion';

/**
 * Multi-line input, mirroring TextField.
 *
 * Same label/error/hint contract and the same generated-id wiring, so the two
 * can sit in one form without their labels or spacing disagreeing.
 */
export function Textarea({
  label,
  error,
  hint,
  className,
  rows = 3,
  id,
  ...props
}: ComponentPropsWithoutRef<'textarea'> & {
  label: string;
  error?: string;
  hint?: string;
}) {
  const reduced = useReducedMotion();
  const generated = useId();
  const fieldId = id ?? generated;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-text text-sm font-medium">
        {label}
      </label>

      <textarea
        {...props}
        id={fieldId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        // Points at whichever of the two is actually rendered, so a screen
        // reader never announces an id that is not in the document.
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={cn(
          'bg-surface text-text placeholder:text-text-subtle w-full rounded-lg border px-3 py-2',
          'text-sm transition-colors outline-none',
          'focus-visible:ring-focus focus-visible:ring-2',
          // Vertical only: horizontal resize breaks the surrounding grid.
          'resize-y',
          error ? 'border-danger-border' : 'border-border focus-visible:border-accent-border',
          className,
        )}
      />

      {hint && !error ? (
        <p id={hintId} className="text-text-subtle text-xs">
          {hint}
        </p>
      ) : null}

      <AnimatePresence initial={false}>
        {error ? (
          <motion.p
            id={errorId}
            role="alert"
            className="text-danger text-xs"
            variants={collapse}
            initial={reduced ? false : 'hidden'}
            animate="visible"
            exit="hidden"
            transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
          >
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
