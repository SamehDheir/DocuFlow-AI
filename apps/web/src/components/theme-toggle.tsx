'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

type Theme = 'light' | 'dark';

const THEME_EVENT = 'docuflow:theme';
const STORAGE_KEY = 'docuflow-theme';

/**
 * The resolved theme is *external* state: it lives on `<html data-theme>`,
 * written before hydration by the boot script in layout.tsx, and otherwise
 * comes from the OS preference.
 *
 * useSyncExternalStore is the correct tool for reading it. Doing the same read
 * inside useEffect sets state synchronously on mount, which costs an extra
 * render pass and is what React's cascading-render lint rule flags.
 */
function subscribe(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  window.addEventListener(THEME_EVENT, onChange);

  return () => {
    media.removeEventListener('change', onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

function getSnapshot(): Theme {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'light' || explicit === 'dark') return explicit;

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The server cannot know the user's preference. React renders this during SSR
 * and hydration, then reconciles with the real value immediately afterwards —
 * no hydration mismatch warning, unlike an effect-driven read.
 */
function getServerSnapshot(): Theme {
  return 'light';
}

export function ThemeToggle({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';

    document.documentElement.dataset.theme = next;

    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing can reject writes; the theme still applies for this
      // session, so this is not worth surfacing to the user.
    }

    // dataset changes are not observable, so tell subscribers explicitly.
    window.dispatchEvent(new Event(THEME_EVENT));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className={cn(
        'relative inline-flex size-9 items-center justify-center rounded-lg',
        'text-text-muted transition-colors duration-fast',
        'hover:bg-surface-inset hover:text-text',
        className,
      )}
    >
      <motion.svg
        viewBox="0 0 20 20"
        className="size-4.5"
        fill="none"
        aria-hidden="true"
        initial={false}
        animate={{ rotate: theme === 'dark' ? -90 : 0 }}
        transition={reduced ? { duration: 0 } : { duration: DURATION.slow, ease: EASE.outExpo }}
      >
        {theme === 'dark' ? (
          <path
            d="M16.5 11.7A7 7 0 0 1 8.3 3.5a7 7 0 1 0 8.2 8.2Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        ) : (
          <>
            <circle cx="10" cy="10" r="3.4" fill="currentColor" />
            <path
              d="M10 1.6v2.1M10 16.3v2.1M18.4 10h-2.1M3.7 10H1.6M15.9 4.1l-1.5 1.5M5.6 14.4l-1.5 1.5M15.9 15.9l-1.5-1.5M5.6 5.6 4.1 4.1"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </>
        )}
      </motion.svg>
    </button>
  );
}
