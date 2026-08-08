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

  /**
   * `onClose` is held in a ref, and this is the whole reason the trap works.
   *
   * Callers pass an inline arrow — `onClose={() => setOpen(false)}` — so its
   * identity changes on EVERY render of the component that owns the dialog.
   * Depending on it directly made the effect below tear down and set up again on
   * every keystroke: the cleanup fired `restoreTo.current?.focus()` and the
   * setup re-focused the panel's first control. Typing one character into the
   * second field of a dialog therefore threw focus back to the first, and
   * `restoreTo` was overwritten with whatever had just been stolen from.
   *
   * The handler reads through the ref instead, so it stays stable and the effect
   * keys on `open` alone — the same shape `useLiveEvent` uses for subscriptions.
   */
  const latestClose = useRef(onClose);

  useEffect(() => {
    latestClose.current = onClose;
  });

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        latestClose.current();
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
    // `panel` is a ref object and never changes identity, so this callback is
    // created once — which is what keeps the effect below from re-running.
    [panel],
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
