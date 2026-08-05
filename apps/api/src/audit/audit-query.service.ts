import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { DEFAULT_PAGE_SIZE } from '../documents/dto/list-documents.dto';
import type { ListAuditDto } from './dto/list-audit.dto';

/**
 * The read side of the audit trail.
 *
 * Deliberately separate from `common/audit/AuditService`, which is the writer:
 * that one is infrastructure injected by every feature module, this one is a
 * feature with a controller and a permission in front of it. Two classes rather
 * than one also keeps the names unambiguous at the injection site.
 */

const ENTRY = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  ipAddress: true,
  userAgent: true,
  metadata: true,
  createdAt: true,
  /**
   * Reached through the relation so the feed can name the actor without a
   * second query. `userId` is nullable — a system-initiated action has no user
   * — so the client must tolerate a null here.
   */
  user: { select: { id: true, firstName: true, lastName: true } },
} as const;

export interface AuditEntryView {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  user: { id: string; firstName: string; lastName: string } | null;
}

@Injectable()
export class AuditQueryService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient) {}

  /**
   * A page of audit entries, newest first.
   *
   * Cursor pagination for the same reason DocumentsService.list() uses it:
   * `@@index([companyId, createdAt])` already exists and is composite with
   * companyId first, and an offset scan degrades exactly where a trail grows —
   * deep into the history of a busy company.
   *
   * No companyId filter appears here on purpose. The tenant guard injects it,
   * and writing one by hand is the pattern CLAUDE.md forbids.
   */
  async list(dto: ListAuditDto): Promise<{ items: AuditEntryView[]; nextCursor: string | null }> {
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;

    const createdAt: Prisma.DateTimeFilter = {
      ...(dto.from ? { gte: new Date(dto.from) } : {}),
      ...(dto.to ? { lte: new Date(dto.to) } : {}),
    };

    const where: Prisma.AuditLogWhereInput = {
      ...(dto.action ? { action: dto.action } : {}),
      ...(dto.entityType ? { entityType: dto.entityType } : {}),
      ...(dto.entityId ? { entityId: dto.entityId } : {}),
      ...(dto.userId ? { userId: dto.userId } : {}),
      ...(dto.from || dto.to ? { createdAt } : {}),
    };

    // One extra row is fetched purely to answer "is there another page?"
    // without a second count query.
    const rows = await this.db.auditLog.findMany({
      where,
      select: ENTRY,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });

    const items = rows.slice(0, limit);

    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * The distinct actions this company has actually recorded.
   *
   * Powers the filter control: offering the full catalogue of 17 actions to a
   * company that has only ever uploaded files is a menu of dead ends.
   */
  async actions(): Promise<string[]> {
    const rows = await this.db.auditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    });

    return rows.map((row) => row.action);
  }
}
