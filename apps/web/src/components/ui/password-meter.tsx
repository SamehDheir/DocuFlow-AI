'use client';

import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

/**
 * Password strength indicator.
 *
 * Scores on length and character variety. This is a UX hint, not a security
 * control — the real policy is enforced server-side, and a client-side meter
 * can always be bypassed.
 */
export function scorePassword(value: string): number {
  if (!value) return 0;

  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^\w\s]/.test(value)) score += 1;

  return Math.min(score, 4);
}

const LABELS = ['Too short', 'Weak', 'Fair', 'Strong', 'Excellent'] as const;
const COLORS = ['bg-border-strong', 'bg-danger', 'bg-warning', 'bg-success', 'bg-accent'] as const;

export function PasswordMeter({ value, className }: { value: string; className?: string }) {
  const score = scorePassword(value);

  if (!value) return null;

  return (
    <div className={cn('mt-2', className)}>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className="h-1 flex-1 overflow-hidden rounded-full bg-surface-inset">
            <motion.span
              className={cn('block h-full origin-left rounded-full', COLORS[score])}
              initial={false}
              animate={{ scaleX: index < score ? 1 : 0 }}
              transition={{ duration: DURATION.base, ease: EASE.outQuint }}
            />
          </span>
        ))}
      </div>
      {/* Announced politely so it does not interrupt typing. */}
      <p className="mt-1.5 text-xs text-text-subtle" aria-live="polite">
        Password strength: <span className="text-text-muted">{LABELS[score]}</span>
      </p>
    </div>
  );
}
