'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** Elements that can hold focus, for the trap below. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The behaviour every modal surface owes its user, in one place.
 *
 * Escape closes, Tab cannot walk out of the panel, the page behind cannot
 * scroll, focus lands on something actionable when it opens, and focus returns
 * to whatever opened it when it closes.
 *
 * Extracted from Dialog when Drawer arrived: two overlays each carrying their
 * own copy of a focus trap is two chances for one of them to quietly lose a
 * piece of it. The trap is the part nobody notices working and everybody
 * notices broken.
 */
export function useModalBehavior({
  open,
  onClose,
  panel,
}: {
  open: boolean;
  onClose: () => void;
  /** The element that bounds the trap. */
  panel: RefObject<HTMLElement | null>;
}) {
  const restoreTo = useRef<HTMLElement | null>(null);

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
    [onClose, panel],
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
  }, [open, handleKeyDown, panel]);
}
