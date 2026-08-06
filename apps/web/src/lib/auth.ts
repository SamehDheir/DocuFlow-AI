/**
 * Auth API client.
 *
 * The access token is never stored here. It lives in memory in the session
 * provider, and every call that needs it is handed it explicitly. Persisting it
 * to localStorage would put a bearer token somewhere any injected script can
 * read it, and the httpOnly refresh cookie already covers surviving a reload.
 *
 * The transport itself now lives in lib/api.ts, shared with documents and
 * folders.
 */

import { ApiError, apiFetch } from './api';

/**
 * Kept as an alias rather than a separate class.
 *
 * The auth forms catch `AuthError` in a dozen places, and SessionProvider keys
 * its 401-retry off it. One error type across the whole client means a
 * documents call that expires mid-flight is renewed by the same path.
 */
export { ApiError as AuthError };

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  companyId: string;
}

/** What `GET /auth/me` adds on top of the session user. */
export interface Profile extends SessionUser {
  company: { id: string; name: string; slug: string };
  roles: string[];
  permissions: string[];
}

export interface Session {
  accessToken: string;
  user: SessionUser;
}

export function signIn(input: { email: string; password: string }) {
  return post<Session>('/auth/login', input);
}

export function registerCompany(input: {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}) {
  return post<Session>('/auth/register', input);
}

/**
 * Registration's other half: an account inside a company that already exists.
 *
 * No company name and no email — both come from the invitation token, which is
 * the credential here. The client never gets to name the tenant it is joining.
 */
export function acceptInvitation(input: {
  token: string;
  firstName: string;
  lastName: string;
  password: string;
}) {
  return post<Session>('/auth/accept-invitation', input);
}

/**
 * Exchanges the httpOnly refresh cookie for a new session.
 *
 * This is also how a reload recovers: the access token was only ever in memory,
 * so the cookie is the sole thing that survived.
 */
export function refreshSession() {
  return post<Session>('/auth/refresh');
}

export function signOut() {
  return post<{ ok: true }>('/auth/logout');
}

export function fetchProfile(accessToken: string) {
  return apiFetch<Profile>('/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Request a password reset link.
 *
 * The endpoint returns 200 whether or not the address is registered. Returning
 * 404 for unknown emails would turn this into an account enumeration oracle —
 * anyone could test which addresses have accounts. The UI shows the same
 * confirmation either way for the same reason.
 */
export function requestPasswordReset(input: { email: string }) {
  return post<{ ok: true }>('/auth/forgot-password', input);
}
