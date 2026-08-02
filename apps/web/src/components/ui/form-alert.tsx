'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

/**
 * Form-level error banner.
 *
 * Shakes once on appearance — the movement registers before the text is read,
 * which matters when the message appears above a form the user is already
 * looking away from. Suppressed under reduced motion.
 */
export function FormAlert({ message, className }: { message?: string; className?: string }) {
  const reduced = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          // assertive: this reports the outcome of an action the user just
          // took, so it should interrupt rather than wait for a pause.
          role="alert"
          aria-live="assertive"
          initial={{ opacity: 0, height: 0, marginBottom: 0 }}
          animate={{
            opacity: 1,
            height: 'auto',
            marginBottom: 20,
            x: reduced ? 0 : [0, -5, 4, -3, 2, 0],
          }}
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          transition={{
            height: { duration: DURATION.base, ease: EASE.outQuint },
            opacity: { duration: DURATION.fast },
            x: { duration: 0.42, ease: EASE.inOutQuart },
          }}
          className="overflow-hidden"
        >
          <div
            className={cn(
              'flex items-start gap-2.5 rounded-lg border border-danger-border bg-danger-subtle px-3.5 py-3',
              className,
            )}
          >
            <svg
              viewBox="0 0 16 16"
              className="mt-px size-4 shrink-0 text-danger"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <path d="M8 4.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
            </svg>
            <p className="text-sm leading-relaxed text-text">{message}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
