'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, useRef } from 'react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';
import { useModalBehavior } from '@/lib/use-modal-behavior';

/**
 * An edge-anchored modal panel.
 *
 * Exists because two things the app needs are the same shape: primary
 * navigation below `sm`, where the header has no room for six tabs, and the
 * folder tree between `sm` and `lg`, where the sidebar is hidden but nothing
 * replaced it. Both are "a list of destinations, temporarily over the page".
 *
 * A drawer rather than a bottom tab bar: a tab bar spends viewport height on
 * every screen forever, has nowhere to put the bell, language, theme and
 * account controls that already live in the header, and is the most
 * recognisable "generated mobile app" silhouette there is. It shares Dialog's
 * overlay, focus trap and scroll lock via `useModalBehavior`, so it is the same
 * mechanism wearing a different geometry rather than a second system.
 *
 * RTL: the panel is anchored with a LOGICAL inset, so `inset-s-0` is the left
 * edge in English and the right edge in Arabic with no second rule. Only the
 * slide has to be told which way it is going — `transform: translateX` is
 * physical, and a panel on the right that flies in from the left crosses the
 * whole screen to get home.
 */
export function Drawer({
  open,
  onClose,
  title,
  closeLabel,
  rtl = false,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  /** Names the panel for assistive tech, and heads it visually. */
  title: string;
  closeLabel: string;
  /**
   * Which edge the panel is pinned to, in physical terms, so the slide matches
   * it. Callers pass `direction[lang] === 'rtl'` — read from the locale rather
   * than measured, since the caller already knows it and `getComputedStyle`
   * would force a layout for an answer that was never in doubt.
   */
  rtl?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useModalBehavior({ open, onClose, panel });

  /** Off-screen resting position: past whichever edge the panel is pinned to. */
  const offscreen = rtl ? '100%' : '-100%';

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50">
          <motion.div
            className="bg-canvas-sunken/70 absolute inset-0 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast }}
            onClick={onClose}
            aria-hidden="true"
          />

          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={cn(
              'border-border bg-surface-raised absolute inset-s-0 top-0 flex h-dvh w-72 max-w-[86vw] flex-col border-e shadow-xl sm:w-80',
              className,
            )}
            /* Reduced motion gets the same panel without the traversal — it
               still appears and disappears, so the state change is legible. */
            initial={reduced ? { opacity: 0 } : { x: offscreen }}
            animate={reduced ? { opacity: 1 } : { x: 0 }}
            exit={reduced ? { opacity: 0 } : { x: offscreen }}
            transition={{ duration: DURATION.base, ease: EASE.outExpo }}
          >
            <header className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-5 py-4">
              <h2 id={titleId} className="font-display text-lg">
                {title}
              </h2>

              <button
                type="button"
                onClick={onClose}
                aria-label={closeLabel}
                className="text-text-subtle hover:bg-surface-inset hover:text-text duration-fast ease-out-quint focus-visible:outline-focus -me-1.5 flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  className="size-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </header>

            {/* Scrolls internally: a workspace with forty folders must not push
                the panel past the bottom of the screen. */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
              {children}
            </div>

            {footer ? (
              <div className="border-border shrink-0 border-t px-5 py-4">{footer}</div>
            ) : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
