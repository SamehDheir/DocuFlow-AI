import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalStatus, NotificationType, Prisma } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import type { RequestContext } from '../common/http/request-context';
import { EventsService } from '../events/events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { tenantCreate, type TenantGuardedClient } from '../prisma/tenant-guard';
import type { DecideApprovalDto, ListApprovalsDto, RequestApprovalDto } from './dto/approval.dto';

/**
 * Single-step document sign-off.
 *
 * The spec routes approvals to a "Department Manager", a role that does not
 * exist in this codebase — Departments is unallocated scope with no schema and
 * no version plan. Rather than invent it, this gates on the `documents.approve`
 * permission against the real Owner/Admin/Member roles. The workflow shape is
 * unchanged if Departments arrives later; only who holds the permission moves.
 *
 * Requesting needs `documents.update` (ordinary document work); deciding needs
 * `documents.approve`, which Member does not have. Both are enforced at the
 * controller.
 */

const APPROVAL_VIEW = {
  id: true,
  status: true,
  note: true,
  decisionNote: true,
  decidedAt: true,
  createdAt: true,
  updatedAt: true,
  document: { select: { id: true, name: true, mimeType: true, extension: true } },
  requestedBy: { select: { id: true, firstName: true, lastName: true } },
  assignee: { select: { id: true, firstName: true, lastName: true } },
  decidedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ApprovalRequestSelect;

const PAGE_SIZE = 20;

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly notifications: NotificationsService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  /** Raises a request for sign-off on a document. */
  async request(
    documentId: string,
    dto: RequestApprovalDto,
    userId: string,
    companyId: string,
    context: RequestContext,
  ) {
    const document = await this.db.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, name: true },
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    if (dto.assigneeId) {
      // Confirms the assignee is in this tenant. The guard scopes the lookup,
      // so a colleague's id from another company simply is not found.
      const assignee = await this.db.user.findFirst({
        where: { id: dto.assigneeId, isActive: true },
        select: { id: true },
      });

      if (!assignee) {
        throw new NotFoundException(apiError(ERROR_CODES.NOT_FOUND, 'That person does not exist'));
      }
    }

    let created;

    try {
      created = await this.db.approvalRequest.create({
        data: tenantCreate({
          documentId,
          requestedById: userId,
          assigneeId: dto.assigneeId ?? null,
          note: dto.note ?? null,
          status: ApprovalStatus.PENDING,
        }),
        select: APPROVAL_VIEW,
      });
    } catch (error) {
      /**
       * The partial unique index caught a second open request. Two concurrent
       * submissions would both pass a SELECT-then-INSERT check, which is why
       * the constraint lives in the database rather than here.
       */
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(
          apiError(
            ERROR_CODES.APPROVAL_ALREADY_PENDING,
            'That document already has an approval request open',
          ),
        );
      }

      throw error;
    }

    await this.audit.record({
      action: 'approval.request',
      entityType: 'ApprovalRequest',
      entityId: created.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { documentId, name: document.name, assigneeId: dto.assigneeId ?? null },
    });

    /**
     * Addressed to the named assignee, or to everyone who could decide it when
     * none was named — otherwise an unassigned request would sit unseen.
     */
    const recipients = dto.assigneeId
      ? [dto.assigneeId]
      : await this.notifications.usersWithPermission('documents.approve');

    await this.notifications.createMany(
      recipients,
      {
        type: NotificationType.APPROVAL_REQUESTED,
        actorId: userId,
        entityType: 'ApprovalRequest',
        entityId: created.id,
        payload: { name: document.name, documentId },
      },
      // Never notify the requester about their own request.
      userId,
    );

    await this.announce(companyId, recipients, documentId, created.id, userId);

    return created;
  }

  /** Approves or rejects. */
  async decide(
    id: string,
    dto: DecideApprovalDto,
    userId: string,
    companyId: string,
    context: RequestContext,
  ) {
    const request = await this.db.approvalRequest.findFirst({
      where: { id },
      select: {
        id: true,
        status: true,
        assigneeId: true,
        requestedById: true,
        documentId: true,
        document: { select: { name: true } },
      },
    });

    if (!request) {
      throw new NotFoundException(
        apiError(ERROR_CODES.APPROVAL_NOT_FOUND, 'That approval request does not exist'),
      );
    }

    if (request.status !== ApprovalStatus.PENDING) {
      throw new ConflictException(
        apiError(ERROR_CODES.APPROVAL_ALREADY_DECIDED, 'That request has already been decided'),
      );
    }

    /**
     * Holding `documents.approve` is not enough on its own. Approving your own
     * request would make the whole workflow ceremonial, and an Owner — who has
     * every permission — is exactly who would otherwise do it by accident.
     */
    if (request.requestedById === userId) {
      throw new ForbiddenException(
        apiError(ERROR_CODES.APPROVAL_SELF_DECISION, 'You cannot decide your own request'),
      );
    }

    // A named assignee makes it theirs. An unassigned request stays open to
    // anyone holding the permission.
    if (request.assigneeId && request.assigneeId !== userId) {
      throw new ForbiddenException(
        apiError(ERROR_CODES.APPROVAL_NOT_ASSIGNEE, 'That request is assigned to someone else'),
      );
    }

    /**
     * Conditioned on status inside the UPDATE, not just checked above. Two
     * approvers deciding at once would both pass the check; this makes the
     * second one a zero-row update it can detect.
     */
    const updated = await this.db.approvalRequest.updateMany({
      where: { id, status: ApprovalStatus.PENDING },
      data: {
        status: dto.decision,
        decisionNote: dto.note ?? null,
        decidedById: userId,
        decidedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      throw new ConflictException(
        apiError(ERROR_CODES.APPROVAL_ALREADY_DECIDED, 'That request has already been decided'),
      );
    }

    await this.audit.record({
      action: dto.decision === ApprovalStatus.APPROVED ? 'approval.approve' : 'approval.reject',
      entityType: 'ApprovalRequest',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { documentId: request.documentId, name: request.document.name },
    });

    await this.notifications.create({
      userId: request.requestedById,
      type:
        dto.decision === ApprovalStatus.APPROVED
          ? NotificationType.APPROVAL_APPROVED
          : NotificationType.APPROVAL_REJECTED,
      actorId: userId,
      entityType: 'ApprovalRequest',
      entityId: id,
      payload: { name: request.document.name, documentId: request.documentId, note: dto.note },
    });

    await this.announce(companyId, [request.requestedById], request.documentId, id, userId);

    return this.findOne(id);
  }

  /** Withdraws a request. Only the person who raised it may. */
  async cancel(id: string, userId: string, companyId: string, context: RequestContext) {
    const request = await this.db.approvalRequest.findFirst({
      where: { id },
      select: { id: true, status: true, requestedById: true, documentId: true, assigneeId: true },
    });

    if (!request) {
      throw new NotFoundException(
        apiError(ERROR_CODES.APPROVAL_NOT_FOUND, 'That approval request does not exist'),
      );
    }

    if (request.requestedById !== userId) {
      throw new ForbiddenException(
        apiError(ERROR_CODES.PERMISSION_DENIED, 'Only the requester can withdraw a request'),
      );
    }

    if (request.status !== ApprovalStatus.PENDING) {
      throw new ConflictException(
        apiError(ERROR_CODES.APPROVAL_ALREADY_DECIDED, 'That request has already been decided'),
      );
    }

    await this.db.approvalRequest.updateMany({
      where: { id, status: ApprovalStatus.PENDING },
      data: { status: ApprovalStatus.CANCELLED, decidedAt: new Date() },
    });

    await this.audit.record({
      action: 'approval.cancel',
      entityType: 'ApprovalRequest',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { documentId: request.documentId },
    });

    await this.announce(
      companyId,
      request.assigneeId ? [request.assigneeId] : [],
      request.documentId,
      id,
      userId,
    );

    return this.findOne(id);
  }

  /** The approvals inbox. */
  async list(dto: ListApprovalsDto, userId: string) {
    const where: Prisma.ApprovalRequestWhereInput = {
      ...(dto.status ? { status: dto.status } : {}),
      // 'me'   → waiting on me: mine by name, or open to anyone.
      // 'mine' → raised by me.
      ...(dto.scope === 'me'
        ? { OR: [{ assigneeId: userId }, { assigneeId: null }] }
        : dto.scope === 'mine'
          ? { requestedById: userId }
          : {}),
    };

    const rows = await this.db.approvalRequest.findMany({
      where,
      select: APPROVAL_VIEW,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });

    const items = rows.slice(0, PAGE_SIZE);

    return {
      items,
      nextCursor: rows.length > PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /** A document's approval history, newest first. */
  forDocument(documentId: string) {
    return this.db.approvalRequest.findMany({
      where: { documentId },
      select: APPROVAL_VIEW,
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findOne(id: string) {
    const request = await this.db.approvalRequest.findFirst({
      where: { id },
      select: APPROVAL_VIEW,
    });

    if (!request) {
      throw new NotFoundException(
        apiError(ERROR_CODES.APPROVAL_NOT_FOUND, 'That approval request does not exist'),
      );
    }

    return request;
  }

  /**
   * Pushes the change to anyone watching.
   *
   * Two events, because they mean different things: `approval.changed` goes to
   * the whole company so an open document view refreshes its badge, while the
   * unread count is addressed to each recipient individually.
   */
  private async announce(
    companyId: string,
    recipients: string[],
    documentId: string,
    approvalId: string,
    actorId: string,
  ): Promise<void> {
    await this.events.publish({
      companyId,
      event: { type: 'approval.changed', documentId, approvalId },
    });

    await Promise.all(
      [...new Set(recipients)]
        .filter((userId) => userId !== actorId)
        .map(async (userId) =>
          this.events.publish({
            companyId,
            userId,
            event: { type: 'notification', unread: await this.notifications.unreadCount(userId) },
          }),
        ),
    );
  }
}
