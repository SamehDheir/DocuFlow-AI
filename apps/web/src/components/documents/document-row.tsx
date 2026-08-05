'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { formatBytes, type DocumentSummary } from '@/lib/documents';
import { DURATION, EASE } from '@/lib/motion';

/** File-type chip. Truncated, or an extension like "spreadsheetml" bursts it. */
function FileGlyph({ extension }: { extension: string }) {
  return (
    <span
      className="border-border bg-surface-inset text-text-subtle flex size-9 shrink-0 items-center justify-center rounded-lg border text-[0.5625rem] font-medium tracking-wide uppercase"
      aria-hidden="true"
    >
      {extension.slice(0, 4)}
    </span>
  );
}

export interface RowAction {
  key: string;
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'danger';
}

/**
 * Menu width, in pixels, matching `w-44` below.
 *
 * Pinned in both places because the open position is computed in JS before the
 * menu has been laid out — an auto width cannot be aligned to the trigger's
 * inline-end edge without measuring first.
 */
const MENU_WIDTH = 176;
/** Space between the trigger and the menu, matching the old `0.25rem` offset. */
const MENU_GAP = 4;
/** Keeps the menu off the viewport edge when a row sits near the window edge. */
const VIEWPORT_MARGIN = 8;

interface Coords {
  top: number;
  left: number;
}

/**
 * One document in the list.
 *
 * Actions sit behind a menu rather than as inline buttons. At 10,000 rows four
 * buttons each is 40,000 focusable elements, and reaching the second document
 * by keyboard would take a dozen presses.
 *
 * The prop is `item`, not `document`, so the global `document` stays reachable
 * for the outside-click listener.
 */
export function DocumentRow({
  item,
  locale,
  t,
  actions,
  onOpen,
}: {
  item: DocumentSummary;
  locale: Locale;
  t: Dictionary['documents'];
  actions: RowAction[];
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const reduced = useReducedMotion();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  /**
   * Anchors the menu to the trigger in viewport coordinates.
   *
   * The menu is rendered through a portal, so this is the only thing tying it
   * to its row — see the note on the portal below for why it cannot simply be
   * positioned by CSS.
   */
  const place = useCallback(() => {
    const button = trigger.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    // Read the resolved direction rather than the locale: the menu must follow
    // whatever `dir` the document actually settled on.
    const rtl = getComputedStyle(button).direction === 'rtl';

    // Aligned on the inline-end edge, then pulled back inside the viewport for
    // a row whose trigger sits close to the window edge.
    const preferred = rtl ? rect.left : rect.right - MENU_WIDTH;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(preferred, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
    );

    setCoords({ top: rect.bottom + MENU_GAP, left });
  }, []);

  /**
   * Flips the menu above its trigger when it would otherwise run off the
   * bottom — the case that matters for the last row of a long list.
   *
   * A layout effect because it measures the rendered menu and corrects the
   * position before paint; in a passive effect the reader would see it jump.
   */
  useLayoutEffect(() => {
    if (!open || !coords || !menu.current || !trigger.current) return;

    const height = menu.current.offsetHeight;
    const rect = trigger.current.getBoundingClientRect();

    const overflowsBelow = coords.top + height > window.innerHeight - VIEWPORT_MARGIN;
    const fitsAbove = rect.top - height - MENU_GAP >= VIEWPORT_MARGIN;

    if (overflowsBelow && fitsAbove) {
      const flipped = rect.top - height - MENU_GAP;
      // Guarded, or the correction re-triggers this effect forever.
      if (Math.abs(flipped - coords.top) > 1) setCoords({ top: flipped, left: coords.left });
    }
  }, [open, coords]);

  useEffect(() => {
    if (!open) return;

    /**
     * The menu is not a DOM descendant of the row, so a containment test
     * against the row alone would read a click on a menu item as an outside
     * click — closing the menu on mousedown and destroying the button before
     * its click could fire, which would make every action silently dead.
     */
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (!container.current?.contains(target) && !menu.current?.contains(target)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };

    /**
     * Closed rather than re-anchored on scroll. Fixed coordinates go stale the
     * moment anything moves, and a menu that drifts away from its row is worse
     * than one that dismisses. Captured, so a scroll in any container counts.
     */
    const dismiss = () => setOpen(false);

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  const modified = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    new Date(item.updatedAt),
  );

  return (
    <div
      ref={container}
      className="hover:bg-surface-inset/60 relative flex items-center gap-4 px-4 py-3 transition-colors"
    >
      <FileGlyph extension={item.extension} />

      <div className="min-w-0 flex-1">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="latin block max-w-full truncate text-start text-sm font-medium hover:underline"
            title={item.name}
          >
            {item.name}
          </button>
        ) : (
          <span className="latin block max-w-full truncate text-sm font-medium" title={item.name}>
            {item.name}
          </span>
        )}

        {/* Size repeats here on mobile, where its own column is hidden. */}
        <span className="text-text-subtle mt-0.5 block text-xs sm:hidden">
          {formatBytes(item.size, locale)}
        </span>
      </div>

      <span className="text-text-muted hidden w-20 shrink-0 text-end text-xs sm:block">
        {formatBytes(item.size, locale)}
      </span>

      <span className="text-text-muted hidden w-28 shrink-0 text-end text-xs md:block">
        {modified}
      </span>

      <div className="shrink-0">
        <button
          ref={trigger}
          type="button"
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }

            // Anchored before the menu exists, so it renders in place rather
            // than at the origin for a frame.
            place();
            setOpen(true);
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={interpolate(t.actions.menu, { name: item.name })}
          className="text-text-subtle hover:text-text hover:bg-surface-inset flex size-8 items-center justify-center rounded-md transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="3" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="8" cy="13" r="1.4" />
          </svg>
        </button>

        {/*
          Rendered into document.body rather than beside the trigger.

          The list container clips its rows with `overflow-hidden` so their
          hover background follows its rounded corners, and an absolutely
          positioned menu inside that subtree is clipped along with them — the
          menu appeared trapped inside the row. Ancestor `motion.div`s animate
          `y`, so their transforms would also capture a `position: fixed`
          child. A portal escapes both at once.
        */}
        {open && coords
          ? createPortal(
              <motion.div
                ref={menu}
                id={menuId}
                role="menu"
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: DURATION.fast, ease: EASE.outExpo }}
                style={{ top: coords.top, left: coords.left, width: MENU_WIDTH }}
                className="border-border bg-surface-raised fixed z-50 origin-top overflow-hidden rounded-lg border py-1 shadow-lg"
              >
                {actions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      action.onSelect();
                    }}
                    className={
                      action.tone === 'danger'
                        ? 'text-danger hover:bg-danger-subtle block w-full px-3 py-2 text-start text-sm transition-colors'
                        : 'hover:bg-surface-inset block w-full px-3 py-2 text-start text-sm transition-colors'
                    }
                  >
                    {action.label}
                  </button>
                ))}
              </motion.div>,
              document.body,
            )
          : null}
      </div>
    </div>
  );
}
