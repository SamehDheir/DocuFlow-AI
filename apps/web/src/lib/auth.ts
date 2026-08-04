/**
 * Auth API client.
 *
 * The access token is never stored here. It lives in memory in the session
 * provider, and every call that needs it is handed it explicitly — see
 * `apiFetch`. Persisting it to localStorage would put a bearer token somewhere
 * any injected script can read it, and the httpOnly refresh cookie already
 * covers surviving a reload.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class AuthError extends Error {
  constructor(
    message: string,
    /** Field-level messages, keyed by form field name. */
    readonly fields?: Record<string, string>,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface ApiErrorBody {
  message?: string | string[];
  errors?: Record<string, string>;
}

async function parseError(response: Response): Promise<AuthError> {
  let parsed: ApiErrorBody = {};

  try {
    parsed = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error body (a proxy timeout page, for instance).
  }

  const message = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;

  return new AuthError(
    message ?? 'Something went wrong. Please try again.',
    parsed.errors,
    response.status,
  );
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_URL}/api${path}`, {
      ...init,
      // The refresh token arrives as an httpOnly cookie, which requires
      // credentials on every auth call.
      credentials: 'include',
    });
  } catch {
    throw new AuthError('Cannot reach the authentication service. Check that the API is running.');
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  return (await response.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
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
  return request<Profile>('/auth/me', {
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
