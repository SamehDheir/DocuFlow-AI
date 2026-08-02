import type { Transition, Variants } from 'motion/react';

/**
 * Shared motion language.
 *
 * Durations and curves live here rather than inline on components so that
 * motion feels like one system. These mirror the --ease-* and --duration-*
 * tokens in globals.css; CSS transitions use the tokens, JS animation uses
 * these constants.
 */

export const EASE = {
  /** Entrances. Fast start, long settle — reads as responsive. */
  outExpo: [0.16, 1, 0.3, 1],
  outQuint: [0.22, 1, 0.36, 1],
  /** Two-way movement that should feel symmetrical. */
  inOutQuart: [0.76, 0, 0.24, 1],
  /** Confirmations only. Overshoot on everything reads as noisy. */
  overshoot: [0.34, 1.56, 0.64, 1],
} as const;

export const DURATION = {
  instant: 0.09,
  fast: 0.16,
  base: 0.24,
  slow: 0.42,
  deliberate: 0.7,
} as const;

export const transition = {
  base: { duration: DURATION.base, ease: EASE.outQuint },
  slow: { duration: DURATION.slow, ease: EASE.outExpo },
} satisfies Record<string, Transition>;

/**
 * Staggered entrance for a column of elements.
 *
 * The delay is small on purpose: anything past ~60ms per item turns a form
 * into a slideshow and makes the page feel slower than it is.
 */
export const stagger: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.055, delayChildren: 0.06 },
  },
};

export const riseItem: Variants = {
  hidden: { opacity: 0, y: 14 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: DURATION.slow, ease: EASE.outExpo },
  },
};

export const fadeItem: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: DURATION.base, ease: EASE.outQuint } },
};

/**
 * Collapse/expand for inline messages. Animating height from 'auto' requires
 * the explicit 'auto' target; without it the row jumps to full height on the
 * first frame.
 */
export const collapse: Variants = {
  hidden: { opacity: 0, height: 0, marginTop: 0 },
  visible: {
    opacity: 1,
    height: 'auto',
    marginTop: 8,
    transition: { duration: DURATION.base, ease: EASE.outQuint },
  },
  exit: {
    opacity: 0,
    height: 0,
    marginTop: 0,
    transition: { duration: DURATION.fast, ease: EASE.inOutQuart },
  },
};

/**
 * Strip movement when the user has asked for reduced motion, keeping opacity
 * so state changes are still perceivable.
 *
 * Pass the result of motion's `useReducedMotion()`.
 */
/** Properties that move an element through space, as opposed to fading it. */
const SPATIAL_PROPS = new Set(['x', 'y', 'z', 'scale', 'rotate', 'skew']);

export function respectMotion(variants: Variants, reduced: boolean | null): Variants {
  if (!reduced) return variants;

  return Object.fromEntries(
    Object.entries(variants).map(([key, value]) => {
      if (typeof value !== 'object' || value === null) return [key, value];

      const kept = Object.entries(value as Record<string, unknown>).filter(
        ([prop]) => !SPATIAL_PROPS.has(prop),
      );

      return [key, Object.fromEntries(kept)];
    }),
  ) as Variants;
}
