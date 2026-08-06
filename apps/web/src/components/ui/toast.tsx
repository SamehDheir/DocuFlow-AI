'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { DURATION, EASE } from '@/lib/motion';

/**
 * Transient confirmations.
 *
 * Uploading, deleting and restoring all finish somewhere other than where the
 * user is looking, and a silent success is indistinguishable from a silent
 * failure. There was no toast system in the app at all, so this is built from
 * the pattern FormAlert already established — AnimatePresence plus an
 * aria-live region.
 */

type ToastTone = 'success' | 'error';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DISMISS_AFTER_MS = 5000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const reduced = useReducedMotion();

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = (nextId.current += 1);

    setToasts((current) => [...current, { id, tone, message }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, DISMISS_AFTER_MS);
  }, []);

  const value = useMemo(
    () => ({
      success: (message: string) => push('success', message),
      error: (message: string) => push('error', message),
    }),
    [push],
  );

  return (
    <ToastContext value={value}>
      {children}

      {/*
        Bottom-centre on mobile, bottom-start on desktop. `inset-s-*` is the
        logical property, so it follows the writing direction — in Arabic the
        stack sits bottom-right without a second rule.
      */}
      <div
        className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-center gap-2 sm:inset-s-6 sm:inset-e-auto sm:items-start"
        /*
         * `polite`, not `assertive`: these confirm things the user just did.
         * Interrupting a screen reader mid-sentence to say "uploaded" is worse
         * than waiting for a pause. FormAlert stays assertive because it
         * reports a failure the user has to act on.
         */
        role="status"
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: DURATION.base, ease: EASE.outExpo }}
              className={
                toast.tone === 'error'
                  ? 'border-danger-border bg-danger-subtle text-text pointer-events-auto max-w-sm rounded-lg border px-4 py-3 text-sm shadow-lg'
                  : 'border-border bg-surface-raised text-text pointer-events-auto max-w-sm rounded-lg border px-4 py-3 text-sm shadow-lg'
              }
            >
              <span className="flex items-start gap-2.5">
                <span
                  className={
                    toast.tone === 'error'
                      ? 'bg-danger mt-1.5 size-1.5 shrink-0 rounded-full'
                      : 'bg-success mt-1.5 size-1.5 shrink-0 rounded-full'
                  }
                  aria-hidden="true"
                />
                {toast.message}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }

  return context;
}
