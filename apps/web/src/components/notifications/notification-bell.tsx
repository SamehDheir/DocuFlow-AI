'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { useLive, useLiveEvent } from '@/components/providers/live-provider';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { relativeTime } from '@/lib/activity';
import { cn } from '@/lib/cn';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type AppNotification,
} from '@/lib/notifications';
import { DURATION, EASE } from '@/lib/motion';

/**
 * The notification bell and its panel.
 *
 * The badge is driven by the live stream rather than polled: LiveProvider keeps
 * the count current, so the number is right without this component asking for
 * it. The list itself is fetched only when the panel opens — an unopened panel
 * should cost nothing.
 */
export function NotificationBell({
  lang,
  t,
  common,
}: {
  lang: Locale;
  t: Dictionary['notifications'];
  common: Dictionary['common'];
}) {
  const { withToken } = useSession();
  const { unread, setUnread } = useLive();
  const reduced = useReducedMotion();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [load, setLoad] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  /** Bumped to refetch, so the fetch itself can stay inline in the effect. */
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  /**
   * Fetched on open, and again on reopen so a panel opened twice is not stale.
   *
   * Nothing is set before the await: the initial 'loading' covers the first
   * open, and a reopen keeps the previous list visible while it refreshes
   * rather than blanking to a skeleton.
   */
  useEffect(() => {
    if (!open) {
      return;
    }

    let current = true;

    void (async () => {
      try {
        const page = await withToken((token) => listNotifications(token, { limit: 8 }));

        if (!current) {
          return;
        }

        setItems(page.items);
        setUnread(page.unread);
        setLoad('ready');
      } catch {
        if (current) {
          setLoad('error');
        }
      }
    })();

    return () => {
      current = false;
    };
  }, [open, reloadKey, withToken, setUnread]);

  /**
   * While the panel is open, a new notification is pulled in live. While it is
   * closed nothing is fetched — the badge has already moved, and the list is
   * loaded fresh on open anyway.
   */
  useLiveEvent((event) => {
    if (event.type === 'notification' && open) {
      refresh();
    }
  });

  // Close on outside click and on Escape, restoring focus to the trigger.
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const readOne = async (notification: AppNotification) => {
    if (notification.readAt) {
      return;
    }

    // Optimistic: marking read is not an operation anyone waits for, and the
    // server's authoritative count arrives in the response below.
    setItems((current) =>
      current.map((item) =>
        item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item,
      ),
    );

    try {
      const { unread: remaining } = await withToken((token) =>
        markNotificationRead(token, notification.id),
      );
      setUnread(remaining);
    } catch {
      // Reconciled by the next open; not worth interrupting anyone over.
    }
  };

  const readAll = async () => {
    setItems((current) =>
      current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })),
    );

    try {
      await withToken(markAllNotificationsRead);
      setUnread(0);
    } catch {
      void refresh();
    }
  };

  return (
    <div ref={container} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        // The count belongs in the accessible name: a bare "Notifications"
        // would hide the one thing the badge exists to communicate.
        aria-label={unread > 0 ? interpolate(t.ariaWithCount, { count: String(unread) }) : t.aria}
        className={cn(
          'text-text-muted hover:text-text relative rounded-lg p-2 transition-colors',
          'focus-visible:ring-focus focus-visible:ring-2 focus-visible:outline-none',
          open && 'text-text bg-surface-inset',
        )}
      >
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 3a5 5 0 0 0-5 5v3.5L3.5 14h13L15 11.5V8a5 5 0 0 0-5-5Z" />
          <path d="M8 16.5a2 2 0 0 0 4 0" />
        </svg>

        <AnimatePresence>
          {unread > 0 ? (
            <motion.span
              // Not aria-hidden's opposite: the count is already in the button's
              // label above, so this is decoration for sighted users only.
              aria-hidden
              initial={reduced ? { opacity: 0 } : { scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={reduced ? { opacity: 0 } : { scale: 0.4, opacity: 0 }}
              transition={{ duration: DURATION.fast, ease: EASE.overshoot }}
              className={cn(
                'bg-accent text-accent-fg absolute top-0.5 inset-e-0.5',
                'flex min-w-4 items-center justify-center rounded-full px-1',
                'text-3xs leading-4 font-semibold tabular-nums',
              )}
            >
              {unread > 99 ? '99+' : unread}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="dialog"
            aria-label={t.title}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
            className={cn(
              'border-border bg-surface-raised absolute inset-e-0 top-[calc(100%+0.5rem)] z-40',
              'w-[min(22rem,calc(100vw-2rem))] origin-top overflow-hidden rounded-xl border shadow-lg',
            )}
          >
            <div className="border-border flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold">{t.title}</h2>

              {unread > 0 ? (
                <button
                  type="button"
                  onClick={() => void readAll()}
                  className="text-accent hover:text-accent-hover rounded text-xs font-medium focus-visible:ring-focus focus-visible:ring-2 focus-visible:outline-none"
                >
                  {t.markAllRead}
                </button>
              ) : null}
            </div>

            <div className="max-h-[min(26rem,60vh)] overflow-y-auto">
              {load === 'loading' && items.length === 0 ? (
                <ul className="divide-border divide-y" aria-busy>
                  {[0, 1, 2].map((index) => (
                    <li key={index} className="px-4 py-3">
                      <div className="bg-surface-inset h-3 w-3/4 animate-pulse rounded" />
                      <div className="bg-surface-inset mt-2 h-2.5 w-1/3 animate-pulse rounded" />
                    </li>
                  ))}
                </ul>
              ) : load === 'error' ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-text-muted text-sm">{common.genericError}</p>
                  <button
                    type="button"
                    onClick={refresh}
                    className="text-accent mt-2 text-xs font-medium"
                  >
                    {t.retry}
                  </button>
                </div>
              ) : items.length === 0 ? (
                <p className="text-text-muted px-4 py-10 text-center text-sm">{t.empty}</p>
              ) : (
                <ul className="divide-border divide-y">
                  {items.map((notification) => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      lang={lang}
                      t={t}
                      onRead={() => void readOne(notification)}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </ul>
              )}
            </div>

            <div className="border-border border-t px-4 py-2.5 text-center">
              <Link
                href={`/${lang}/activity`}
                onClick={() => setOpen(false)}
                className="text-text-muted hover:text-text rounded text-xs font-medium transition-colors focus-visible:ring-focus focus-visible:ring-2 focus-visible:outline-none"
              >
                {t.viewActivity}
              </Link>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function NotificationItem({
  notification,
  lang,
  t,
  onRead,
  onNavigate,
}: {
  notification: AppNotification;
  lang: Locale;
  t: Dictionary['notifications'];
  onRead: () => void;
  onNavigate: () => void;
}) {
  /**
   * The sentence is built here, from a type and a payload — the server stores
   * no prose. That is what makes an eight-month-old notification render in
   * Arabic the moment the language is switched.
   *
   * Falls back to the raw type so a notification kind added before its
   * translation still reads as something, matching the activity feed.
   */
  const template = t.types[notification.type as keyof typeof t.types] ?? notification.type;
  const message = interpolate(template, {
    name: notification.payload?.name ?? '',
    actor: notification.actor
      ? `${notification.actor.firstName} ${notification.actor.lastName}`
      : t.system,
  });

  const documentId = notification.payload?.documentId ?? notification.entityId;
  const href =
    notification.entityType === 'Document' && documentId
      ? `/${lang}/documents`
      : notification.type.startsWith('APPROVAL')
        ? `/${lang}/approvals`
        : null;

  const body = (
    <>
      <p className={cn('text-sm', notification.readAt ? 'text-text-muted' : 'text-text')}>
        {message}
      </p>

      {notification.payload?.reason ? (
        <p className="text-danger mt-1 text-xs">{notification.payload.reason}</p>
      ) : null}

      <time
        dateTime={notification.createdAt}
        title={new Date(notification.createdAt).toLocaleString(lang)}
        className="text-text-subtle mt-1 block text-xs"
      >
        {relativeTime(notification.createdAt, lang)}
      </time>
    </>
  );

  return (
    <li className={cn('relative', !notification.readAt && 'bg-accent-subtle/35')}>
      {/* Unread marker: a bar, not colour alone, so it survives a colour-vision
          difference and a high-contrast theme. */}
      {!notification.readAt ? (
        <span aria-hidden className="bg-accent absolute inset-s-0 top-0 h-full w-0.5" />
      ) : null}

      {href ? (
        <Link
          href={href}
          onClick={() => {
            onRead();
            onNavigate();
          }}
          className="hover:bg-surface-inset/60 block px-4 py-3 transition-colors focus-visible:ring-focus focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
        >
          {body}
        </Link>
      ) : (
        <button
          type="button"
          onClick={onRead}
          className="hover:bg-surface-inset/60 block w-full px-4 py-3 text-start transition-colors focus-visible:ring-focus focus-visible:ring-2 focus-visible:outline-none"
        >
          {body}
        </button>
      )}
    </li>
  );
}
