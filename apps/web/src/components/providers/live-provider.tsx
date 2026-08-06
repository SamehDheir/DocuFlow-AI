'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSession } from '@/components/auth/session-provider';
import { readEventStream, type LiveEvent } from '@/lib/event-stream';
import { unreadCount as fetchUnreadCount } from '@/lib/notifications';

/**
 * One live connection for the whole signed-in app.
 *
 * Every view that cares about server-side change subscribes here rather than
 * opening its own stream. Browsers cap concurrent connections per origin, and a
 * page showing the document list, the bell and a preview would otherwise hold
 * three — all carrying identical traffic.
 *
 * Subscribers are held in a ref'd Set, so adding or removing one does not
 * re-render the provider and therefore does not restart the connection.
 */
interface LiveContextValue {
  /** Registers a listener. Returns its unsubscribe. */
  subscribe: (listener: (event: LiveEvent) => void) => () => void;
  /** Unread notifications, kept current by the stream. */
  unread: number;
  /** Lets the bell correct the count after marking things read. */
  setUnread: (unread: number) => void;
  connected: boolean;
}

const LiveContext = createContext<LiveContextValue | null>(null);

/** Reconnect backoff: quick first retry, then easing off to 30s. */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const { status, withToken } = useSession();
  const [unread, setUnread] = useState(0);
  /**
   * Whether the stream itself is open. `connected` below is derived from this
   * AND the session, rather than being a third piece of state kept in sync —
   * signing out cannot leave a stale `true` behind if the flag is not stored.
   */
  const [streamOpen, setStreamOpen] = useState(false);

  const listeners = useRef(new Set<(event: LiveEvent) => void>());

  const subscribe = useCallback((listener: (event: LiveEvent) => void) => {
    listeners.current.add(listener);

    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') {
      return;
    }

    const controller = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const dispatch = (event: LiveEvent) => {
      // The heartbeat exists only to hold the connection open through proxies.
      if (event.type === 'ping') {
        return;
      }

      if (event.type === 'notification') {
        setUnread(event.unread);
      }

      for (const listener of listeners.current) {
        listener(event);
      }
    };

    const connect = async () => {
      if (stopped) {
        return;
      }

      try {
        /**
         * Reconciles the badge on every (re)connect, before the stream opens.
         * Events that fired while the connection was down are gone — the stream
         * carries no history — so the count has to be re-read rather than
         * assumed to have survived.
         */
        const { unread: current } = await withToken(fetchUnreadCount);

        if (stopped) {
          return;
        }

        setUnread(current);
        setStreamOpen(true);
        attempt = 0;

        // withToken renews once and replays on a 401, so an access token that
        // expires mid-stream reconnects with a fresh one instead of signing out.
        await withToken((token) => readEventStream(token, dispatch, controller.signal));
      } catch {
        // Swallowed on purpose. A dropped stream is not a user-facing error —
        // the data is still there on the next request — so it retries quietly
        // rather than throwing a toast at someone whose wifi blinked.
      }

      if (stopped) {
        return;
      }

      setStreamOpen(false);

      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => void connect(), delay);
    };

    void connect();

    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [status, withToken]);

  const value = useMemo<LiveContextValue>(
    () => ({ subscribe, unread, setUnread, connected: status === 'authenticated' && streamOpen }),
    [subscribe, unread, status, streamOpen],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const context = useContext(LiveContext);

  if (!context) {
    throw new Error('useLive must be used inside <LiveProvider>');
  }

  return context;
}

/**
 * Subscribes to live events for the lifetime of a component.
 *
 * The handler is held in a ref so a caller can pass an inline arrow function
 * without re-subscribing on every render — which is the shape everyone reaches
 * for first, and the one that would otherwise churn the listener set.
 */
export function useLiveEvent(handler: (event: LiveEvent) => void): void {
  const { subscribe } = useLive();
  const ref = useRef(handler);

  useEffect(() => {
    ref.current = handler;
  });

  useEffect(() => subscribe((event) => ref.current(event)), [subscribe]);
}
