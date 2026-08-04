'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

/** Elements that can hold focus, for the trap below. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog with a real focus trap.
 *
 * UserMenu was the only overlay in the app and has neither a trap nor a
 * restore — acceptable for a menu you can click away from, not for a
 * confirmation that asks before deleting something. Tab must not be able to
 * walk behind the dialog and press a button the user cannot see.
 *
 * On close, focus returns to whatever opened it, so a keyboard user is not
 * dumped back at the top of the document.
 */
/**
 * Panel widths. `lg` exists for the document preview, where a form-sized modal
 * would show a PDF through a letterbox.
 */
const SIZES = {
  md: 'max-w-md',
  lg: 'max-w-4xl',
} as const;

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: keyof typeof SIZES;
}) {
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !panel.current) return;

      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrap in both directions rather than letting focus escape the panel.
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;

    restoreTo.current = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', handleKeyDown);

    // The page behind must not scroll while a modal is over it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first control, not the panel, so the reader lands somewhere
    // actionable.
    const focusable = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus();
    };
  }, [open, handleKeyDown]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
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
            aria-describedby={description ? descriptionId : undefined}
            className={cn(
              'border-border bg-surface-raised relative flex max-h-[90dvh] w-full flex-col rounded-xl border p-6 shadow-xl',
              SIZES[size],
            )}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: DURATION.base, ease: EASE.outExpo }}
          >
            <h2 id={titleId} className="font-display text-xl">
              {title}
            </h2>

            {description ? (
              <p id={descriptionId} className="text-text-muted mt-2 text-sm">
                {description}
              </p>
            ) : null}

            {/* Scrolls internally so a tall preview never pushes the footer
                off-screen; max-h on the panel is what gives this a bound. */}
            {children ? <div className="mt-5 min-h-0 flex-1 overflow-auto">{children}</div> : null}

            {footer ? <div className="mt-6 flex shrink-0 justify-end gap-2">{footer}</div> : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
