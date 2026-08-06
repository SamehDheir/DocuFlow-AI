import { Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';

/**
 * The company's own roles.
 *
 * Roles are per-tenant rows — every company gets its own Owner/Admin/Member at
 * registration and may edit them afterwards — so these queries go through the
 * tenant guard like any other scoped read. The `permissions` catalogue they
 * point at is the one global table.
 */

/**
 * Reached through Role, never by querying RolePermission directly: that join
 * table carries no companyId of its own and the tenant guard passes it through
 * unfiltered. Same reasoning as PermissionsService.effectiveFor().
 */
const ROLE = {
  id: true,
  name: true,
  description: true,
  permissions: { select: { permission: { select: { name: true, module: true } } } },
  _count: { select: { users: true } },
} as const;

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  /** How many people hold it — what makes "this is the last Owner" visible. */
  memberCount: number;
}

@Injectable()
export class RolesService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient) {}

  /**
   * Every role in the company, most-privileged first.
   *
   * Ordered by permission count rather than by name so the list reads as a
   * ladder — Owner, Admin, Member — instead of alphabetically, which would put
   * Admin above Owner and imply the wrong hierarchy.
   *
   * No pagination: a company has a handful of roles, and the role picker on the
   * members screen wants all of them at once.
   */
  async list(): Promise<{ items: RoleView[]; total: number }> {
    const rows = await this.db.role.findMany({ select: ROLE });

    const items = rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        permissions: row.permissions.map((entry) => entry.permission.name),
        memberCount: row._count.users,
      }))
      .sort((a, b) => b.permissions.length - a.permissions.length || a.name.localeCompare(b.name));

    return { items, total: items.length };
  }
}
