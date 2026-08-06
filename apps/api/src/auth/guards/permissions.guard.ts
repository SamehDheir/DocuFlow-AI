import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, apiError } from '../../common/errors/error-codes';
import type { PermissionName } from '../../permissions/permissions.catalogue';
import { PermissionsService } from '../../permissions/permissions.service';
import type { AuthenticatedRequest } from '../auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRED_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

/**
 * Enforces @RequirePermissions().
 *
 * Registered as a second APP_GUARD, listed AFTER JwtAuthGuard — registration
 * order is execution order, and this guard assumes a principal has already been
 * established. Routes without the decorator pass straight through, so this is
 * opt-in per route while authentication stays opt-out.
 *
 * Permissions are read from the database on each guarded request rather than
 * carried in the JWT. A token lasts fifteen minutes; revoking a role has to
 * take effect sooner than that, and it is one indexed query.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    // A public route cannot meaningfully require a permission — there is no
    // principal to check one against. Treated as unguarded rather than as a
    // 403, matching how JwtAuthGuard reads the same decorator.
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<PermissionName[]>(
      REQUIRED_PERMISSIONS_KEY,
      targets,
    );

    if (!required?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      // JwtAuthGuard should have rejected this already; failing closed here
      // means a future reordering cannot silently open a guarded route.
      throw new ForbiddenException(
        apiError(ERROR_CODES.PERMISSION_DENIED, 'You do not have access to this resource'),
      );
    }

    const granted = await this.permissions.effectiveFor(request.user.sub);
    const missing = required.filter((permission) => !granted.has(permission));

    if (missing.length > 0) {
      throw new ForbiddenException(
        apiError(ERROR_CODES.PERMISSION_DENIED, 'You do not have access to this resource', {
          // Named so an administrator can see which capability to grant. The
          // caller is already authenticated within the company, so this
          // discloses nothing they could not read from /auth/me.
          permissions: missing.join(', '),
        }),
      );
    }

    return true;
  }
}
