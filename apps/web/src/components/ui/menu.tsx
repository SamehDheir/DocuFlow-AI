'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DURATION, EASE } from '@/lib/motion';

export interface MenuAction {
  key: string;
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'danger';
}

/**
 * Where the menu hangs from.
 *
 * `element` is a button that owns the menu — anchored under it, aligned on its
 * inline-end edge. `pointer` is a right-click — anchored at the cursor. Both
 * carry an element, because the inline axis has to be resolved against the
 * `dir` that actually applies at that point in the tree rather than against the
 * locale, and a bare pair of coordinates cannot answer that.
 */
export type MenuOrigin =
  | { kind: 'element'; el: HTMLElement }
  | { kind: 'pointer'; x: number; y: number; host: HTMLElement };

/**
 * Menu width, in pixels, matching `w-44` below.
 *
 * Pinned in both places because the open position is computed before the menu
 * has been laid out — an auto width cannot be aligned to an edge without
 * measuring first.
 */
const MENU_WIDTH = 176;
/** Space between the anchor and the menu. */
const MENU_GAP = 4;
/** Keeps the menu off the viewport edge when the anchor sits near it. */
const VIEWPORT_MARGIN = 8;

const ITEM_SELECTOR = '[role="menuitem"]';

/**
 * A pop-up menu, portalled and positioned in viewport coordinates.
 *
 * Extracted from DocumentRow when folders needed the same thing. The
 * positioning is the fiddly part and having one copy of it means a fix for the
 * document list is a fix for the folder tree.
 *
 * Rendered into `document.body` rather than beside its anchor: list containers
 * clip their rows with `overflow-hidden` so hover backgrounds follow rounded
 * corners, and an absolutely positioned menu inside that subtree is clipped
 * along with them. Ancestor `motion.div`s animate `y`, so their transforms
 * would also capture a `position: fixed` child. A portal escapes both at once.
 *
 * Keyboard follows the ARIA menu pattern: focus enters the menu on open, arrows
 * and Home/End move within it, Escape closes and hands focus back to whatever
 * opened it, and Tab closes rather than walking into the portal — which sits at
 * the end of `body`, so tabbing would otherwise jump the reader to the bottom
 * of the document.
 */
export function Menu({
  id,
  /** `null` closes the menu. */
  origin,
  onClose,
  actions,
  label,
}: {
  id: string;
  origin: MenuOrigin | null;
  onClose: () => void;
  actions: MenuAction[];
  label: string;
}) {
  const reduced = useReducedMotion();
  const menu = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  const open = origin !== null;

  /**
   * Where the menu goes, derived straight from the origin rather than held in
   * state. Nothing to clear when the menu closes, and no frame where a new
   * anchor is showing the previous one's coordinates.
   *
   * It reads layout during render, which is safe here because `origin` is only
   * ever set from a pointer or key event — there is no server render in which
   * this runs.
   */
  const base = useMemo(() => {
    if (!origin) return null;

    // Read the resolved direction rather than the locale: the menu must follow
    // whatever `dir` the document actually settled on at this point.
    const host = origin.kind === 'element' ? origin.el : origin.host;
    const rtl = getComputedStyle(host).direction === 'rtl';

    /** The anchor's box. A pointer origin is a zero-height box at the cursor,
     *  which lets the flip below treat both kinds the same way. */
    let top: number;
    let bottom: number;
    let preferred: number;

    if (origin.kind === 'element') {
      const rect = origin.el.getBoundingClientRect();
      top = rect.top;
      bottom = rect.bottom;
      // Aligned on the anchor's inline-end edge.
      preferred = rtl ? rect.left : rect.right - MENU_WIDTH;
    } else {
      top = origin.y;
      bottom = origin.y;
      // Hangs from the cursor's inline-start corner, the way a desktop context
      // menu does — mirrored, so in Arabic it opens towards the text.
      preferred = rtl ? origin.x - MENU_WIDTH : origin.x;
    }

    return {
      anchorTop: top,
      top: bottom + MENU_GAP,
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(preferred, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
      ),
    };
  }, [origin]);

  /**
   * The correction that lifts the menu above its anchor when it would otherwise
   * run off the bottom — the case that matters for the last row of a long list.
   *
   * Tagged with the origin it was measured against, so a stale flip is ignored
   * the instant a new anchor arrives instead of having to be reset.
   */
  const [flip, setFlip] = useState<{ origin: MenuOrigin; top: number } | null>(null);
  const flippedTop = flip && flip.origin === origin ? flip.top : null;

  /**
   * A layout effect because it measures the rendered menu and corrects the
   * position before paint; in a passive effect the reader would see it jump.
   */
  useLayoutEffect(() => {
    if (!origin || !base || !menu.current) return;

    const height = menu.current.offsetHeight;
    const overflowsBelow = base.top + height > window.innerHeight - VIEWPORT_MARGIN;
    const fitsAbove = base.anchorTop - height - MENU_GAP >= VIEWPORT_MARGIN;

    if (overflowsBelow && fitsAbove) setFlip({ origin, top: base.anchorTop - height - MENU_GAP });
  }, [origin, base]);

  const coords = base ? { top: flippedTop ?? base.top, left: base.left } : null;
  const flipped = flippedTop !== null;

  const items = useCallback(
    () => [...(menu.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])],
    [],
  );

  /**
   * Focus enters the menu when it opens, and again if it is re-anchored onto a
   * different row without closing first.
   *
   * Keyed on `origin` rather than on the resolved coordinates: those change
   * again when the flip correction lands, and re-running this then would drag
   * focus back to the first item after the reader had already arrowed past it.
   */
  useEffect(() => {
    if (!origin) return;

    restoreTo.current ??= document.activeElement as HTMLElement | null;
    items()[0]?.focus();
  }, [origin, items]);

  useEffect(() => {
    if (!open) {
      restoreTo.current = null;
      return;
    }

    /**
     * The menu is not a DOM descendant of its anchor, so a containment test
     * against the anchor alone would read a click on a menu item as an outside
     * click — closing the menu on mousedown and destroying the button before
     * its click could fire, which would make every action silently dead.
     */
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const host = origin.kind === 'element' ? origin.el : origin.host;

      if (!menu.current?.contains(target) && !host.contains(target)) onClose();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const focusable = items();
      if (focusable.length === 0) return;

      const index = focusable.indexOf(document.activeElement as HTMLElement);

      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          onClose();
          restoreTo.current?.focus();
          break;
        case 'Tab':
          // A menu is a mode, not a stop on the tab route.
          onClose();
          restoreTo.current?.focus();
          break;
        case 'ArrowDown':
          event.preventDefault();
          focusable[(index + 1) % focusable.length]?.focus();
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusable[(index - 1 + focusable.length) % focusable.length]?.focus();
          break;
        case 'Home':
          event.preventDefault();
          focusable[0]?.focus();
          break;
        case 'End':
          event.preventDefault();
          focusable[focusable.length - 1]?.focus();
          break;
      }
    };

    /**
     * Closed rather than re-anchored on scroll. Fixed coordinates go stale the
     * moment anything moves, and a menu that drifts away from its row is worse
     * than one that dismisses. Captured, so a scroll in any container counts.
     */
    const dismiss = () => onClose();

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
  }, [open, origin, onClose, items]);

  /*
   * No AnimatePresence around this. It cannot track a portal — the element it
   * receives is the portal, not the motion component inside it, and with no key
   * to follow it drops the child instead of animating it, which took the menu
   * off screen entirely. The menu opens with motion and closes at once, which
   * is what this component did before it was extracted.
   */
  return (
    <>
      {open && coords
        ? createPortal(
            <motion.div
              ref={menu}
              id={id}
              role="menu"
              aria-label={label}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: flipped ? 4 : -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: DURATION.fast, ease: EASE.outExpo }}
              style={{ top: coords.top, left: coords.left, width: MENU_WIDTH }}
              className={`border-border bg-surface-raised fixed z-50 overflow-hidden rounded-lg border py-1 shadow-lg ${
                flipped ? 'origin-bottom' : 'origin-top'
              }`}
            >
              {actions.map((action, index) => (
                <div key={action.key}>
                  {/*
                    A rule above the destructive action, which is otherwise
                    distinguished only by colour. In a five-item menu that is
                    one mis-aimed pixel between "Reprocess" and "Move to trash".
                  */}
                  {action.tone === 'danger' && index > 0 ? (
                    <div
                      role="separator"
                      className="border-border my-1 border-t"
                      aria-hidden="true"
                    />
                  ) : null}

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onClose();
                      action.onSelect();
                    }}
                    className={
                      action.tone === 'danger'
                        ? 'text-danger hover:bg-danger-subtle focus-visible:bg-danger-subtle focus-visible:outline-focus block w-full px-3 py-2 text-start text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2'
                        : 'hover:bg-surface-inset focus-visible:bg-surface-inset focus-visible:outline-focus block w-full px-3 py-2 text-start text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2'
                    }
                  >
                    {action.label}
                  </button>
                </div>
              ))}
            </motion.div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Turns a `contextmenu` event into a menu origin.
 *
 * Keyboard-initiated context menus (Shift+F10, the Menu key) fire the same
 * event with no useful coordinates, so those fall back to the element — landing
 * the menu on the row rather than in the top-left corner of the window.
 */
export function originFromContextMenu(
  event: React.MouseEvent<HTMLElement>,
  fallback: HTMLElement | null,
): MenuOrigin | null {
  const host = event.currentTarget;

  if (event.clientX === 0 && event.clientY === 0) {
    return fallback ? { kind: 'element', el: fallback } : null;
  }

  return { kind: 'pointer', x: event.clientX, y: event.clientY, host };
}
