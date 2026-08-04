import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { PERMISSIONS, type PermissionName } from './permissions.catalogue';

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

  /** Resolves catalogue names to row ids, for building RolePermission links. */
  async idsByName(names: readonly PermissionName[]): Promise<Map<string, string>> {
    const rows = await this.db.permission.findMany({
      where: { name: { in: [...names] } },
      select: { id: true, name: true },
    });

    return new Map(rows.map((row) => [row.name, row.id]));
  }
}
