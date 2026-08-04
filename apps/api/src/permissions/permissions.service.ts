import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { PERMISSIONS, type PermissionName } from './permissions.catalogue';

/**
 * Hydrates a user's roles together with the permission names they grant.
 *
 * Shared so the guard and `/auth/me` describe a principal's authority the same
 * way. Two spellings of "what may this user do" is how they drift apart.
 */
export const WITH_ROLE_PERMISSIONS = {
  roles: {
    select: {
      role: {
        select: {
          name: true,
          permissions: { select: { permission: { select: { name: true } } } },
        },
      },
    },
  },
} satisfies Prisma.UserInclude;

type WithRolePermissions = {
  roles: { role: { permissions: { permission: { name: string } }[] } }[];
};

/** Flattens the role→permission join into the set an authorisation check wants. */
export function permissionsOf(user: WithRolePermissions): Set<string> {
  return new Set(
    user.roles.flatMap((link) => link.role.permissions.map((entry) => entry.permission.name)),
  );
}

/**
 * Keeps the `permissions` table in step with the code-defined catalogue.
 *
 * The table is global, so the tenant guard passes these queries through
 * untouched and no tenant context is required.
 */
@Injectable()
export class PermissionsService implements OnModuleInit {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient) {}

  async onModuleInit(): Promise<void> {
    await this.sync();
  }

  /**
   * Inserts catalogue entries the database does not have yet.
   *
   * Additive only. Renaming or removing a permission also has to rewrite the
   * `role_permissions` rows pointing at it, which is migration work rather than
   * something to do silently on every boot.
   */
  async sync(): Promise<void> {
    const { count } = await this.db.permission.createMany({
      data: [...PERMISSIONS],
      skipDuplicates: true,
    });

    if (count > 0) {
      this.logger.log(`Registered ${count} new permission(s) in the catalogue`);
    }
  }

  /**
   * Every permission a user currently holds, via their roles.
   *
   * Deliberately `findFirst` rather than `findUnique`: the tenant guard filters
   * a findFirst BEFORE execution, while findUnique is only verified after
   * (Prisma accepts unique fields alone in its `where`). Both are safe, but the
   * pre-filtered form means a user id belonging to another company simply
   * matches nothing.
   *
   * Reads through `User` rather than `UserRole`, because UserRole and
   * RolePermission carry no companyId of their own and the guard passes them
   * through unfiltered — reaching them via the scoped parent is what keeps this
   * query tenant-safe.
   *
   * An inactive or unknown user yields an empty set, so a deactivated account
   * fails closed rather than retaining whatever its roles last granted.
   */
  async effectiveFor(userId: string): Promise<Set<string>> {
    const user = await this.db.user.findFirst({
      where: { id: userId, isActive: true },
      select: WITH_ROLE_PERMISSIONS,
    });

    return user ? permissionsOf(user) : new Set();
  }

  /** Resolves catalogue names to row ids, for building RolePermission links. */
  async idsByName(names: readonly PermissionName[]): Promise<Map<string, string>> {
    const rows = await this.db.permission.findMany({
      where: { name: { in: [...names] } },
      select: { id: true, name: true },
    });

    return new Map(rows.map((row) => [row.name, row.id]));
  }
}
