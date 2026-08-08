'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Avatar } from '@/components/ui/avatar';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

export function UserMenu({ lang, t }: { lang: Locale; t: Dictionary['app'] }) {
  const { user, logout } = useSession();
  const router = useRouter();
  const reduced = useReducedMotion();

  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const menuId = useId();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  async function onSignOut() {
    setLeaving(true);
    await logout();
    router.replace(`/${lang}/login`);
  }

  return (
    <div ref={container} className="relative">
      {/*
        The button is a bare hit target and Avatar carries the whole look, so the
        hover state has to cross the boundary — hence `group` here and
        `group-hover:` there. The alternative, duplicating the avatar's fill and
        border on the button, is how the account menu drifted away from the
        members list in the first place.
      */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t.account}
        className={cn(
          'group flex rounded-full',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        <Avatar
          firstName={user.firstName}
          lastName={user.lastName}
          tone="accent"
          className="group-hover:bg-accent group-hover:text-accent-fg transition-colors duration-fast ease-out-quint"
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={menuId}
            role="menu"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
            // Logical inset so the menu hangs from the correct edge in Arabic.
            className="absolute inset-e-0 top-[calc(100%+0.5rem)] z-40 w-60 origin-top overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg"
          >
            <div className="border-b border-border px-4 py-3">
              <p className="truncate text-sm font-medium">
                {user.firstName} {user.lastName}
              </p>
              {/* Addresses are LTR even on an RTL page. */}
              <p dir="ltr" className="truncate text-xs text-text-subtle rtl:text-end">
                {user.email}
              </p>
            </div>

            <button
              type="button"
              role="menuitem"
              onClick={() => void onSignOut()}
              disabled={leaving}
              className={cn(
                'flex w-full items-center gap-2.5 px-4 py-3 text-start text-sm',
                'transition-colors duration-fast ease-out-quint',
                'hover:bg-surface-inset focus-visible:bg-surface-inset',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                leaving && 'pointer-events-none opacity-60',
              )}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                className="size-4 shrink-0 text-text-subtle rtl:-scale-x-100"
              >
                <path
                  d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6M10.5 11 14 8l-3.5-3M14 8H6"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {t.signOut}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
