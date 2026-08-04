'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AuthError, refreshSession, signOut, type Session, type SessionUser } from '@/lib/auth';

/**
 * Set by the API alongside the refresh cookie, path `/` and readable by script.
 * It says only that a session was started — never who, and never a credential.
 */
const SESSION_COOKIE = 'docuflow_session';

type Status = 'restoring' | 'authenticated' | 'anonymous';

interface SessionContextValue {
  status: Status;
  user: SessionUser | null;
  /** Runs `call` with a live access token, renewing once if it has expired. */
  withToken: <T>(call: (token: string) => Promise<T>) => Promise<T>;
  /** Adopts the session a login or registration just returned. */
  adopt: (session: Session) => void;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Whether a session cookie exists, read as EXTERNAL state.
 *
 * `document.cookie` is unavailable during SSR, so reading it in render would
 * make the server and the first client render disagree. useSyncExternalStore
 * exists for exactly this: the server snapshot assumes a session is being
 * restored, and React reconciles with the real value straight after hydration
 * without a mismatch warning — the same treatment theme-toggle gives the theme.
 *
 * Nothing subscribes, because the value only decides whether a cold load should
 * attempt a restore. Once that resolves, the session state below outranks it.
 */
function subscribe(): () => void {
  return () => undefined;
}

function readCookie(): boolean {
  return document.cookie.split('; ').some((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
}

function readCookieOnServer(): boolean {
  return true;
}

/**
 * Holds the session for the browser.
 *
 * The access token lives in a ref and never reaches localStorage, so an
 * injected script has nothing durable to steal. The cost is that a reload
 * forgets it — which is what the httpOnly refresh cookie is for, and why the
 * first paint after a reload is a `restoring` state rather than a logged-out
 * one.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const mayHaveSession = useSyncExternalStore(subscribe, readCookie, readCookieOnServer);

  /** `undefined` until a restore, a login, or a failure has settled it. */
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  const token = useRef<string | null>(null);
  /** In-flight renewal, shared so concurrent callers issue one request. */
  const renewal = useRef<Promise<Session> | null>(null);

  /**
   * Derived rather than stored. Keeping a second copy in state is what forces
   * an effect to write it, and that write is a cascading render.
   */
  const status: Status =
    user === undefined
      ? mayHaveSession
        ? 'restoring'
        : 'anonymous'
      : user
        ? 'authenticated'
        : 'anonymous';

  const adopt = useCallback((session: Session) => {
    token.current = session.accessToken;
    setUser(session.user);
  }, []);

  const clear = useCallback(() => {
    token.current = null;
    setUser(null);
  }, []);

  const renew = useCallback((): Promise<Session> => {
    renewal.current ??= refreshSession()
      .then((session) => {
        adopt(session);
        return session;
      })
      .catch((error: unknown) => {
        clear();
        throw error;
      })
      .finally(() => {
        renewal.current = null;
      });

    return renewal.current;
  }, [adopt, clear]);

  const withToken = useCallback(
    async <T,>(call: (accessToken: string) => Promise<T>): Promise<T> => {
      const current = token.current ?? (await renew()).accessToken;

      try {
        return await call(current);
      } catch (error) {
        // Access tokens last minutes, so expiry mid-session is routine rather
        // than exceptional. Renew and replay once; a second 401 is real.
        if (!(error instanceof AuthError) || error.status !== 401) throw error;

        const renewed = await renew();
        return call(renewed.accessToken);
      }
    },
    [renew],
  );

  const logout = useCallback(async () => {
    try {
      await signOut();
    } catch {
      // The token may already be revoked or the API unreachable. Either way the
      // local session must end, or the UI keeps claiming someone is signed in.
    }

    clear();
  }, [clear]);

  useEffect(() => {
    // No cookie means there is nothing to restore, and `status` already reads
    // as anonymous without this effect touching state.
    if (!mayHaveSession || user !== undefined) return;

    void renew().catch(() => {
      // Already handled: renew() clears the session on failure.
    });
  }, [mayHaveSession, user, renew]);

  const value = useMemo(
    () => ({ status, user: user ?? null, withToken, adopt, logout }),
    [status, user, withToken, adopt, logout],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);

  if (!context) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }

  return context;
}
