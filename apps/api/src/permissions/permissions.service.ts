import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { DEFAULT_ROLES, PERMISSIONS, type PermissionName } from './permissions.catalogue';

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

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly tenant: TenantContextService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sync();
  }

  /**
   * Inserts catalogue entries the database does not have yet, and grants them
   * to the companies that already exist.
   *
   * Additive only. Renaming or removing a permission also has to rewrite the
   * `role_permissions` rows pointing at it, which is migration work rather than
   * something to do silently on every boot.
   *
   * THE SECOND HALF IS NOT OPTIONAL. Registering a permission in the global
   * catalogue grants it to nobody: roles are per-company rows materialised at
   * registration, so a company that signed up before the permission existed has
   * no link to it. Adding `search.read` for v2 and stopping at the catalogue is
   * exactly how every pre-existing tenant got PERMISSION_DENIED on a feature
   * that worked perfectly for anyone who registered afterwards.
   */
  async sync(): Promise<void> {
    const { count } = await this.db.permission.createMany({
      data: [...PERMISSIONS],
      skipDuplicates: true,
    });

    if (count > 0) {
      this.logger.log(`Registered ${count} new permission(s) in the catalogue`);
    }

    await this.reconcileDefaultRoles();
  }

  /**
   * Brings every company's default roles back in line with their template.
   *
   * Runs on each boot rather than only when the catalogue grows, because the
   * two can fall out of step in either direction and the failure is silent
   * until a user hits a 403 on a feature that plainly works for a colleague who
   * signed up a day later.
   *
   * Matched by role NAME, which is all that identifies a role as one we
   * shipped. A company that renamed its roles or built its own is left alone.
   *
   * ONLY ADDS, never revokes: a company may legitimately hold permissions the
   * template does not list, and removing those is destructive in a way that
   * boot-time reconciliation has no business being.
   *
   * NARROW THIS WHEN ROLE EDITING SHIPS. Today `roles.manage` has no controller
   * behind it, so no one can have deliberately taken a permission away and
   * re-granting cannot undo an intentional choice. Once a UI exists, an admin
   * who revokes `search.read` from Member would otherwise find it restored on
   * the next restart — at that point this has to become "grant only what was
   * newly registered", with the customisation recorded somewhere it can be
   * distinguished from drift.
   */
  private async reconcileDefaultRoles(): Promise<void> {
    const ids = await this.idsByName(PERMISSIONS.map((permission) => permission.name));

    /**
     * Roles are tenant-scoped and boot has no request behind it, so the guard
     * would fail closed on every query here. Repairing every company at once is
     * precisely the cross-tenant maintenance runAsSystem() is the sanctioned
     * escape hatch for.
     */
    await this.tenant.runAsSystem(async () => {
      for (const template of DEFAULT_ROLES) {
        const roles = await this.db.role.findMany({
          where: { name: template.name },
          select: { id: true, permissions: { select: { permissionId: true } } },
        });

        const links = roles.flatMap((role) => {
          const held = new Set(role.permissions.map((entry) => entry.permissionId));

          return template.permissions
            .map((name) => ids.get(name))
            .filter((id): id is string => Boolean(id) && !held.has(id as string))
            .map((permissionId) => ({ roleId: role.id, permissionId }));
        });

        if (links.length === 0) {
          continue;
        }

        const { count } = await this.db.rolePermission.createMany({
          data: links,
          skipDuplicates: true,
        });

        this.logger.log(
          `Granted ${count} missing permission link(s) to existing "${template.name}" role(s)`,
        );
      }
    });
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
