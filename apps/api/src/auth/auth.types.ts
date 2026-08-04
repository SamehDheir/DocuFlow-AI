import type { Request } from 'express';

/**
 * Access token claims.
 *
 * `company_id` is snake_case because the token is a wire format shared with the
 * web client, and the payload shape is fixed in CLAUDE.md. It is mapped to
 * camelCase at the edge (JwtMiddleware) so nothing downstream deals with both.
 */
export interface JwtPayload {
  sub: string;
  company_id: string;
  roles: string[];
}

/** The authenticated principal, as attached to the request. */
export interface AuthenticatedUser {
  sub: string;
  companyId: string;
  roles: string[];
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/** Matches the web client's `SessionUser` in apps/web/src/lib/auth.ts. */
export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  companyId: string;
}

export interface AuthResult {
  accessToken: string;
  user: SessionUser;
  /** Opaque refresh token; the controller sets it as an httpOnly cookie. */
  refreshToken: string;
}
