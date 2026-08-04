/**
 * The shared API client.
 *
 * Extracted from lib/auth.ts, which owned a private `request()` shaped entirely
 * around authentication. Documents and folders need the same transport — the
 * `/api` prefix, `credentials: 'include'`, and the error unwrapping — so it
 * lives here and auth re-exports its half.
 *
 * No access token is stored here. It lives in memory in SessionProvider and is
 * handed to each call explicitly, so a token can never outlive the tab or be
 * read out of localStorage by an injected script.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * A failed request.
 *
 * `code` is the API's stable identifier for the failure — the web maps it to a
 * translated string, and falls back to `message` (English, written once at the
 * API) for anything the dictionary has not covered.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    /** Field-level messages, keyed by form field name. */
    readonly fields?: Record<string, string>,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiErrorBody {
  message?: string | string[];
  errors?: Record<string, string>;
  code?: string;
}

async function parseError(response: Response): Promise<ApiError> {
  let parsed: ApiErrorBody = {};

  try {
    parsed = (await response.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error body (a proxy timeout page, for instance).
  }

  // class-validator returns an array of messages; the first is the useful one.
  const message = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;

  return new ApiError(
    message ?? 'Something went wrong. Please try again.',
    parsed.errors,
    response.status,
    parsed.code,
  );
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_URL}/api${path}`, {
      ...init,
      // The refresh token is an httpOnly cookie, so it only travels when
      // credentials are included.
      credentials: 'include',
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check that the API is running.');
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  // 204 No Content — a folder delete, for instance — has nothing to parse.
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/** Authenticated GET. */
export function apiGet<T>(path: string, token: string): Promise<T> {
  return apiFetch<T>(path, { headers: { Authorization: `Bearer ${token}` } });
}

/** Authenticated JSON body request. */
export function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  return apiFetch<T>(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Builds a query string, dropping empty values but KEEPING deliberate blanks. */
export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  const rendered = search.toString();

  return rendered ? `?${rendered}` : '';
}
