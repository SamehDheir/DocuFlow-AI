'use client';

import { motion, useReducedMotion } from 'motion/react';
import { DURATION, EASE } from '@/lib/motion';
import { cn } from '@/lib/cn';

/**
 * Determinate progress bar, for uploads.
 *
 * Deliberately determinate: a spinner during a 100 MB upload tells the user
 * nothing about whether to wait or give up. The percentage is carried in ARIA
 * as well as the fill, so the value is available without seeing it.
 */
export function Progress({
  value,
  label,
  className,
  tone = 'accent',
}: {
  /** 0–100. */
  value: number;
  label: string;
  className?: string;
  tone?: 'accent' | 'danger';
}) {
  const reduced = useReducedMotion();
  const clamped = Math.min(100, Math.max(0, value));

  return (
    <div
      className={cn('bg-surface-inset h-1.5 w-full overflow-hidden rounded-full', className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <motion.div
        className={tone === 'danger' ? 'bg-danger h-full' : 'bg-accent h-full'}
        initial={{ width: 0 }}
        animate={{ width: `${clamped}%` }}
        // Under reduced motion the bar still moves — it is data, not decoration
        // — but it snaps rather than easing.
        transition={reduced ? { duration: 0 } : { duration: DURATION.fast, ease: EASE.outQuint }}
      />
    </div>
  );
}
