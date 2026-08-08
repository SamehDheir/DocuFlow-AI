'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cloneElement, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

/**
 * A short label attached to a control.
 *
 * SCOPE, DELIBERATELY NARROW. There is no collision detection and no flipping at
 * the viewport edge — that needs a positioning engine, and pulling one in for a
 * handful of icon buttons is not a trade worth making. So this is for a few
 * words next to a control that is not against the edge of the screen. Anything
 * longer, or anything that has to wrap, belongs in the visible layout.
 *
 * WHY cloneElement RATHER THAN A WRAPPER. `aria-describedby` has to sit on the
 * focusable element itself; on a span around it, most screen readers never
 * announce it. Wrapping would also break the parent's flex layout for what is
 * meant to be an invisible addition. So the single child is cloned with the
 * handlers and the description id, and the caller keeps their own element.
 *
 * TOUCH IS EXCLUDED ON PURPOSE. A tooltip is a hover affordance and there is no
 * hover on a touchscreen; showing one on tap means the first tap does something
 * other than what the control says. Coarse pointers get nothing here, so a
 * control whose only label is a tooltip still needs `aria-label`.
 */
const OPEN_DELAY = 350;

type Placement = 'top' | 'bottom' | 'start' | 'end';

const PLACEMENT: Record<Placement, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  start: 'inset-e-full top-1/2 -translate-y-1/2 me-2',
  end: 'inset-s-full top-1/2 -translate-y-1/2 ms-2',
};

/** Where the tooltip slides in from — the direction it is anchored. */
const OFFSET: Record<Placement, { x?: number; y?: number }> = {
  top: { y: 4 },
  bottom: { y: -4 },
  start: { x: 4 },
  end: { x: -4 },
};

export function Tooltip({
  content,
  placement = 'top',
  children,
}: {
  content: React.ReactNode;
  placement?: Placement;
  /** A single focusable element. It is cloned, not wrapped. */
  children: ReactElement<React.HTMLAttributes<HTMLElement> & { 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reduced = useReducedMotion();

  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };

  // A stray timer would fire after unmount and set state on a dead component.
  useEffect(() => cancel, []);

  /**
   * Delayed on hover so sweeping the cursor across a toolbar does not strobe
   * every tooltip in it — but INSTANT on focus, because a keyboard user asked
   * for this control specifically and has nothing else to look at.
   */
  const show = (immediate: boolean) => {
    cancel();

    if (immediate) {
      setOpen(true);
      return;
    }

    timer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
  };

  const hide = () => {
    cancel();
    setOpen(false);
  };

  /**
   * `react-hooks/refs` flags any object handed to a function during render that
   * could carry a `ref`, on the assumption that the callee dereferences it. This
   * one does not: the props below are handlers and an id string, nothing here
   * reads `.current`, and in React 19 `ref` is an ordinary prop that
   * `cloneElement` forwards untouched. The rule cannot tell those apart.
   */
  // eslint-disable-next-line react-hooks/refs
  const trigger = cloneElement(children, {
    'aria-describedby': open ? id : children.props['aria-describedby'],
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      children.props.onPointerEnter?.(event);

      if (event.pointerType !== 'touch') {
        show(false);
      }
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      children.props.onPointerLeave?.(event);
      hide();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      show(true);
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      hide();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      children.props.onKeyDown?.(event);

      // WCAG 1.4.13: content shown on hover or focus must be dismissible
      // without moving the pointer or the focus.
      if (event.key === 'Escape' && open) {
        hide();
      }
    },
  });

  return (
    /*
      `min-w-0` is load-bearing, not tidiness. This wrapper is usually a flex
      item, and a flex item's min-width defaults to `auto` — it refuses to shrink
      below its content. A truncating child inside it therefore never truncates:
      it overflows its container instead, which is how a 64-character checksum
      ended up hanging outside the details card. A tooltip must never change the
      box its trigger occupies.
    */
    <span className="relative inline-flex min-w-0 max-w-full">
      {trigger}

      <AnimatePresence>
        {open ? (
          <motion.span
            id={id}
            role="tooltip"
            initial={reduced ? { opacity: 0 } : { opacity: 0, ...OFFSET[placement] }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
            className={cn(
              'absolute z-50 w-max max-w-56 rounded-md px-2 py-1',
              'bg-text text-text-inverse text-2xs font-medium text-balance',
              'shadow-md',
              // The tooltip must never eat a click meant for what it covers.
              'pointer-events-none',
              PLACEMENT[placement],
            )}
          >
            {content}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
