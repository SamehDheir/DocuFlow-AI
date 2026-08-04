/**
 * Auth API client.
 *
 * STATUS: the backend endpoints do not exist yet — `POST /api/auth/login` and
 * `POST /api/auth/register` are the next backend task. These functions issue
 * the real requests already, so wiring them up is a backend-only change; until
 * then they surface a clear "not available" error rather than pretending to
 * succeed. A fake success here would hide the missing backend behind a UI that
 * looks finished.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class AuthError extends Error {
  constructor(
    message: string,
    /** Field-level messages, keyed by form field name. */
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface ApiErrorBody {
  message?: string | string[];
  errors?: Record<string, string>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_URL}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The refresh token is expected to arrive as an httpOnly cookie, which
      // requires credentials on every auth call.
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError('Cannot reach the authentication service. Check that the API is running.');
  }

  if (response.status === 404) {
    throw new AuthError(
      'Authentication is not available yet — this endpoint is still being built.',
    );
  }

  if (!response.ok) {
    let parsed: ApiErrorBody = {};
    try {
      parsed = (await response.json()) as ApiErrorBody;
    } catch {
      // Non-JSON error body (a proxy timeout page, for instance).
    }

    const message = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;
    throw new AuthError(message ?? 'Something went wrong. Please try again.', parsed.errors);
  }

  return (await response.json()) as T;
}

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  companyId: string;
}

export function signIn(input: { email: string; password: string }) {
  return post<{ accessToken: string; user: SessionUser }>('/auth/login', input);
}

/**
 * Request a password reset link.
 *
 * The endpoint is expected to return 200 whether or not the address is
 * registered. Returning 404 for unknown emails would turn this into an account
 * enumeration oracle — anyone could test which addresses have accounts. The UI
 * shows the same confirmation either way for the same reason.
 */
export function requestPasswordReset(input: { email: string }) {
  return post<{ ok: true }>('/auth/forgot-password', input);
}

export function registerCompany(input: {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}) {
  return post<{ accessToken: string; user: SessionUser }>('/auth/register', input);
}
