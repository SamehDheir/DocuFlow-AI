'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { useToast } from '@/components/ui/toast';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { cn } from '@/lib/cn';
import { setFavorite } from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { DURATION, EASE } from '@/lib/motion';

/**
 * The star.
 *
 * OPTIMISTIC, AND IT HAS TO BE. This sits on a list row: the gesture is a
 * single click and the feedback has to be immediate, or a reader clicking down a
 * page of twenty documents watches their marks appear out of order behind the
 * network. So the parent's state flips first and reverts if the request fails —
 * which is safe because both halves are idempotent server-side. Starring twice
 * is not an error and neither is unstarring something that was never starred,
 * so a reverted click leaves nothing half-done.
 *
 * The parent owns the value rather than this component holding its own copy:
 * the same document can be on screen once in a list and again in a dialog, and
 * two stars disagreeing about one bookmark is worse than either being slow.
 *
 * No toast on success. A favourite is a private, reversible, one-click act;
 * announcing each one would make the common case noisier than the failure.
 */
export function FavoriteStar({
  id,
  name,
  favorite,
  onChange,
  t,
  errors,
  common,
  size = 'md',
  className,
}: {
  id: string;
  /** Only for the accessible label — the button itself shows no text. */
  name: string;
  favorite: boolean;
  /** Called with the new value immediately, and again with the old one if the request fails. */
  onChange: (favorite: boolean) => void;
  t: Dictionary['documents'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { withToken } = useSession();
  const toast = useToast();
  const reduced = useReducedMotion();
  const [pending, setPending] = useState(false);

  const label = interpolate(favorite ? t.favorites.remove : t.favorites.add, { name });

  const toggle = async () => {
    if (pending) return;

    const next = !favorite;

    setPending(true);
    onChange(next);

    try {
      await withToken((token) => setFavorite(token, id, next));
    } catch (error) {
      onChange(!next);
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      // Not `aria-label` alone: `aria-pressed` is what tells a screen reader
      // this is a two-state control rather than an action that fires once.
      aria-pressed={favorite}
      aria-label={label}
      title={label}
      className={cn(
        'focus-visible:outline-focus flex shrink-0 items-center justify-center rounded-md',
        'transition-colors duration-fast ease-out-quint',
        'focus-visible:outline-2 focus-visible:outline-offset-2',
        size === 'sm' ? 'size-7' : 'size-8',
        favorite
          ? 'text-warning hover:bg-warning-subtle'
          : 'text-text-subtle hover:text-text hover:bg-surface-inset',
        className,
      )}
    >
      <motion.svg
        viewBox="0 0 20 20"
        className={size === 'sm' ? 'size-3.5' : 'size-4'}
        aria-hidden="true"
        fill={favorite ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={favorite ? 0 : 1.6}
        strokeLinejoin="round"
        // A small pop on the way in, nothing on the way out: filling the star is
        // the moment worth marking, and animating the removal too would draw the
        // eye to an undo.
        animate={reduced || !favorite ? { scale: 1 } : { scale: [1, 1.25, 1] }}
        transition={{ duration: DURATION.base, ease: EASE.overshoot }}
      >
        <path d="M10 2.6l2.24 4.54 5.01.73-3.62 3.53.85 4.99L10 14.04l-4.48 2.35.85-4.99L2.75 7.87l5.01-.73L10 2.6z" />
      </motion.svg>
    </button>
  );
}
