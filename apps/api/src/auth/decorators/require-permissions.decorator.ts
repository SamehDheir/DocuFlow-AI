import { SetMetadata } from '@nestjs/common';
import type { PermissionName } from '../../permissions/permissions.catalogue';

export const REQUIRED_PERMISSIONS_KEY = 'auth:permissions';

/**
 * Declares the capabilities a route needs.
 *
 * Typed against the catalogue, so a misspelled permission is a compile error
 * rather than a route nobody can ever call. All listed permissions are
 * required — this is AND, not OR.
 *
 *   @RequirePermissions('documents.create')
 *   @Post()
 *   upload(...) {}
 *
 * A route with no decorator is authenticated but unrestricted, matching the
 * existing posture where @Public() is the explicit opt-out from authentication.
 */
export const RequirePermissions = (...permissions: PermissionName[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
