import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth.types';

/**
 * Injects the authenticated principal.
 *
 * Typed as non-optional because JwtAuthGuard has already rejected the request
 * if there is no user. On a `@Public()` route there may genuinely be none, so
 * read `req.user` directly there instead of using this.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user as AuthenticatedUser;
  },
);
