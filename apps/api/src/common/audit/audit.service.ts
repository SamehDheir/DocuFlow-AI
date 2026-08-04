import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../../prisma/prisma.module';
import type { TenantGuardedClient, TenantTransactionClient } from '../../prisma/tenant-guard';
import { TenantContextService } from '../tenant/tenant-context.service';

/** Anything exposing the `auditLog` delegate — the client or a transaction. */
export type AuditWriter = Pick<TenantGuardedClient | TenantTransactionClient, 'auditLog'>;

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string;
  /**
   * Required only when writing from outside a bound tenant context — login and
   * registration both run under `runAsSystem()`, where the guard cannot supply
   * the company itself.
   */
  companyId?: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Writes the "who did what" trail.
 *
 * "Who changed or deleted this file" is a problem the product exists to solve,
 * so every mutating operation is expected to leave a row here.
 *
 * Failures are logged and swallowed. An audit write is a side effect of the
 * real operation, and letting a full disk turn every successful login into a
 * 500 trades a monitoring problem for an outage.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Pass `client` to enlist the row in a caller's transaction, so an action and
   * its audit record commit or roll back together.
   */
  async record(entry: AuditEntry, client: AuditWriter = this.db): Promise<void> {
    // Read the ambient tenant before switching contexts below, since
    // runAsSystem() deliberately hides it.
    const companyId = entry.companyId ?? this.tenant.getCompanyId();
    const userId = entry.userId ?? this.tenant.getUserId() ?? null;

    if (!companyId) {
      this.logger.error(`Dropped audit entry "${entry.action}": no company to attribute it to`);
      return;
    }

    try {
      /**
       * Written under bypass with the company pinned explicitly above.
       *
       * The most security-relevant entries — a failed login, a logout, a
       * refresh token replayed — happen on anonymous requests, where no tenant
       * context exists for the guard to apply. Leaving it to stamp the company
       * would mean the trail goes quiet exactly when someone is attacking it.
       */
      await this.tenant.runAsSystem(() =>
        client.auditLog.create({
          data: {
            companyId,
            userId,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId ?? null,
            ipAddress: entry.ipAddress ?? null,
            userAgent: entry.userAgent ?? null,
            metadata: entry.metadata as Prisma.InputJsonValue | undefined,
          },
        }),
      );
    } catch (error) {
      this.logger.error(`Failed to write audit entry "${entry.action}"`, error);
    }
  }
}
