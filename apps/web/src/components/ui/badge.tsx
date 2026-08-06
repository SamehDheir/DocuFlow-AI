'use client';

import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

/**
 * A small status chip.
 *
 * Four tones drawn entirely from the token layer — each has a subtle fill, a
 * matching border and a readable foreground, so the chip stays legible in both
 * themes without a single literal colour.
 *
 * `pulse` marks work still in progress. It is a slow breathing dot rather than
 * a spinner: a row in a list should not carry something that spins, and the dot
 * survives being placed inside dense table rows where a spinner reads as noise.
 */
export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-inset text-text-muted border-border',
  accent: 'bg-accent-subtle text-accent border-accent-border',
  success: 'bg-success-subtle text-success border-success-border',
  warning: 'bg-warning-subtle text-warning border-warning-border',
  danger: 'bg-danger-subtle text-danger border-danger-border',
};

const DOTS: Record<BadgeTone, string> = {
  neutral: 'bg-text-subtle',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export function Badge({
  children,
  tone = 'neutral',
  pulse = false,
  dot = false,
  title,
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  /** Animates the dot, for a state that is still changing. Implies `dot`. */
  pulse?: boolean;
  dot?: boolean;
  /** Native tooltip — used to explain a failure without widening the chip. */
  title?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const showDot = dot || pulse;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
        'text-2xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
      title={title}
    >
      {showDot ? (
        <motion.span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', DOTS[tone])}
          // Reduced motion keeps the dot — it is a state marker, not decoration
          // — but stops it moving.
          animate={pulse && !reduced ? { opacity: [1, 0.35, 1], scale: [1, 0.85, 1] } : undefined}
          transition={
            pulse && !reduced
              ? { duration: DURATION.deliberate * 2.4, repeat: Infinity, ease: EASE.inOutQuart }
              : undefined
          }
        />
      ) : null}
      {children}
    </span>
  );
}
