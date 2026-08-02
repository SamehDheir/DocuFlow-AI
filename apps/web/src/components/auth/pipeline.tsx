'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

/**
 * The real document lifecycle from PROJECT_DOCUMENTATION.md §11, animated.
 *
 * Deliberately not decorative: it shows a prospective user what the product
 * actually does to a file after upload. Abstract blobs and gradient meshes are
 * interchangeable between products; this only makes sense for this one.
 */
const STAGES = [
  { label: 'Uploaded', detail: 'Stored in encrypted object storage' },
  { label: 'Processing', detail: 'Thumbnails and metadata extracted' },
  { label: 'OCR', detail: 'Text recovered from scans and images' },
  { label: 'AI analysis', detail: 'Summarised, classified, indexed' },
  { label: 'Ready', detail: 'Searchable across your workspace' },
] as const;

const STEP_MS = 1500;

export function Pipeline({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  const [cycled, setCycled] = useState(0);

  useEffect(() => {
    if (reduced) return;

    const id = setInterval(() => {
      setCycled((current) => (current + 1) % STAGES.length);
    }, STEP_MS);

    return () => clearInterval(id);
  }, [reduced]);

  /**
   * Derived rather than stored. Writing the reduced-motion value into state
   * from inside the effect would set state synchronously on mount and trigger
   * a second render pass for something already knowable at render time.
   *
   * Under reduced motion the pipeline is shown already complete — the
   * information survives, the movement does not.
   */
  const active = reduced ? STAGES.length - 1 : cycled;

  return (
    <ul className={cn('relative flex flex-col gap-5', className)}>
      {/* Rail the nodes sit on */}
      <span aria-hidden="true" className="absolute top-2 bottom-2 left-1.75 w-px bg-white/12" />

      {STAGES.map((stage, index) => {
        const done = index < active;
        const current = index === active;

        return (
          <li key={stage.label} className="relative flex items-start gap-4">
            <span className="relative mt-0.5 flex size-3.75 shrink-0 items-center justify-center">
              {current && !reduced && (
                <motion.span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-full bg-accent/45"
                  initial={{ opacity: 0.5, scale: 0.9 }}
                  animate={{ opacity: 0, scale: 2.1 }}
                  transition={{ duration: 1.4, ease: EASE.outQuint, repeat: Infinity }}
                />
              )}
              <motion.span
                className={cn(
                  'relative size-2.25 rounded-full ring-2 transition-colors',
                  current || done ? 'bg-accent ring-accent/30' : 'bg-white/25 ring-transparent',
                )}
                animate={reduced ? undefined : { scale: current ? 1.25 : 1 }}
                transition={{ duration: DURATION.base, ease: EASE.overshoot }}
              />
            </span>

            <div className="min-w-0 pb-0.5">
              <motion.p
                className={cn(
                  'text-sm font-medium transition-colors',
                  current ? 'text-white' : done ? 'text-white/70' : 'text-white/40',
                )}
                animate={reduced ? undefined : { x: current ? 2 : 0 }}
                transition={{ duration: DURATION.base, ease: EASE.outQuint }}
              >
                {stage.label}
              </motion.p>
              <p
                className={cn(
                  'text-xs transition-colors',
                  current ? 'text-white/60' : 'text-white/30',
                )}
              >
                {stage.detail}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
