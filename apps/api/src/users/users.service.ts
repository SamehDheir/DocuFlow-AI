import { Inject, Injectable } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';

/**
 * Colleagues within the current company.
 *
 * Read-only in v1. `users.invite` and `users.update` are in the catalogue but
 * deliberately unconsumed — inviting and editing people is v2 scope.
 */

/**
 * `passwordHash` is absent by construction.
 *
 * An explicit select rather than `include`, so a column added to the model
 * later cannot silently start appearing in an API response.
 */
const MEMBER = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  isActive: true,
  createdAt: true,
  /**
   * Reached through User, never by querying UserRole directly: that join table
   * carries no companyId of its own and the tenant guard passes it through
   * unfiltered. Same reasoning as PermissionsService.effectiveFor().
   */
  roles: { select: { role: { select: { name: true } } } },
} as const;

export interface MemberView {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  isActive: boolean;
  createdAt: Date;
  roles: string[];
}

@Injectable()
export class UsersService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient) {}

  /**
   * Every member of the company, active first, then by name.
   *
   * No cursor here, unlike documents and audit: a company's headcount is
   * bounded in a way its archive is not, and the dashboard wants the total
   * anyway. If a tenant ever grows past a page of this, it earns pagination
   * then.
   */
  async list(): Promise<{ items: MemberView[]; total: number }> {
    const rows = await this.db.user.findMany({
      select: MEMBER,
      orderBy: [{ isActive: 'desc' }, { firstName: 'asc' }, { lastName: 'asc' }],
    });

    const items = rows.map((row) => ({
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      isActive: row.isActive,
      createdAt: row.createdAt,
      roles: row.roles.map((link) => link.role.name),
    }));

    return { items, total: items.length };
  }
}
