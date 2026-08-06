import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType, type Prisma } from '@prisma/client';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { tenantCreate, type TenantGuardedClient } from '../prisma/tenant-guard';
import { DEFAULT_NOTIFICATION_PAGE_SIZE } from './dto/list-notifications.dto';

/**
 * The in-app inbox.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. `userId` ALWAYS comes from the authenticated principal, never from a
 *     request parameter. The tenant guard scopes rows to the company, but every
 *     colleague shares that company — reading someone else's inbox would be a
 *     within-tenant leak the guard cannot see. Every query below therefore pins
 *     both companyId (by the guard) and userId (by hand).
 *
 *  2. No rendered text is stored. Rows carry a type and a payload, and the web
 *     renders them through its dictionaries — see the Notification model.
 */

const NOTIFICATION_VIEW = {
  id: true,
  type: true,
  entityType: true,
  entityId: true,
  payload: true,
  readAt: true,
  createdAt: true,
  actor: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.NotificationSelect;

export interface CreateNotification {
  userId: string;
  type: NotificationType;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient) {}

  /**
   * Writes one notification.
   *
   * Failures are logged and swallowed, matching AuditService: a notification is
   * a side effect of the real operation, and failing an approval decision
   * because its notification could not be written would trade a cosmetic
   * problem for a functional one.
   */
  async create(entry: CreateNotification): Promise<void> {
    try {
      await this.db.notification.create({
        data: tenantCreate({
          userId: entry.userId,
          type: entry.type,
          actorId: entry.actorId ?? null,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          payload: (entry.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        }),
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write a ${entry.type} notification for user ${entry.userId}`,
        error,
      );
    }
  }

  /**
   * Notifies several people at once, skipping `exceptUserId`.
   *
   * Used when a request goes to whoever can approve it: the person who raised
   * it should not be told about their own action.
   */
  async createMany(
    userIds: string[],
    entry: Omit<CreateNotification, 'userId'>,
    exceptUserId?: string,
  ): Promise<void> {
    const recipients = [...new Set(userIds)].filter((id) => id !== exceptUserId);

    await Promise.all(recipients.map((userId) => this.create({ ...entry, userId })));
  }

  /** A page of the caller's own notifications, newest first. */
  async list(
    userId: string,
    options: { cursor?: string; limit?: number; unreadOnly?: boolean },
  ): Promise<{ items: unknown[]; nextCursor: string | null; unread: number }> {
    const limit = options.limit ?? DEFAULT_NOTIFICATION_PAGE_SIZE;

    const [rows, unread] = await Promise.all([
      this.db.notification.findMany({
        where: { userId, ...(options.unreadOnly ? { readAt: null } : {}) },
        select: NOTIFICATION_VIEW,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        // One extra row answers "is there another page?" without a second count.
        take: limit + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      }),
      this.unreadCount(userId),
    ]);

    const items = rows.slice(0, limit);

    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
      unread,
    };
  }

  /** Drives the badge on the bell. */
  unreadCount(userId: string): Promise<number> {
    return this.db.notification.count({ where: { userId, readAt: null } });
  }

  /**
   * Marks one as read.
   *
   * Scoped by userId as well as id, so passing a colleague's notification id
   * reads as "not found" rather than marking their mail read.
   */
  async markRead(id: string, userId: string): Promise<{ unread: number }> {
    const updated = await this.db.notification.updateMany({
      // updateMany, not update: it takes an arbitrary where-clause, so userId
      // can be part of the predicate rather than checked afterwards.
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (updated.count === 0) {
      // Distinguish "already read" from "not yours": only the latter is a 404.
      const exists = await this.db.notification.count({ where: { id, userId } });

      if (exists === 0) {
        throw new NotFoundException(
          apiError(ERROR_CODES.NOTIFICATION_NOT_FOUND, 'That notification does not exist'),
        );
      }
    }

    return { unread: await this.unreadCount(userId) };
  }

  async markAllRead(userId: string): Promise<{ unread: number }> {
    await this.db.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });

    return { unread: 0 };
  }

  /**
   * Everyone in the company holding a given permission.
   *
   * Used to address an approval request that names no assignee. Reads through
   * User → UserRole → Role → RolePermission because the join tables carry no
   * companyId of their own and are only protected transitively — the same
   * reason PermissionsService.effectiveFor() starts from User.
   */
  async usersWithPermission(permission: string): Promise<string[]> {
    const users = await this.db.user.findMany({
      where: {
        isActive: true,
        roles: { some: { role: { permissions: { some: { permission: { name: permission } } } } } },
      },
      select: { id: true },
    });

    return users.map((user) => user.id);
  }
}

export { NotificationType };
