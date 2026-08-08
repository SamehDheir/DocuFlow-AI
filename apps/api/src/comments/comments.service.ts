import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType, type Prisma } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import type { RequestContext } from '../common/http/request-context';
import { EventsService } from '../events/events.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PermissionsService } from '../permissions/permissions.service';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { tenantCreate, type TenantGuardedClient } from '../prisma/tenant-guard';
import {
  DEFAULT_COMMENT_PAGE_SIZE,
  type CreateCommentDto,
  type ListCommentsDto,
  type UpdateCommentDto,
} from './dto/comment.dto';

const COMMENT_VIEW = {
  id: true,
  documentId: true,
  body: true,
  editedAt: true,
  createdAt: true,
  author: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.CommentSelect;

/**
 * Discussion attached to a document — spec §12, Collaboration.
 *
 * Three rules shape every method here:
 *
 *  1. **Reading rides on `documents.read`.** A separate read permission would
 *     only produce documents whose comment count you can see but not the
 *     comments, which is a worse answer than either alternative.
 *
 *  2. **Authorship is checked in the service, not the guard.** PermissionsGuard
 *     ANDs a fixed list; it has no way to express "the author, OR anyone holding
 *     `comments.moderate`". The route asks for the permission that lets you take
 *     part at all, and whose comment you may touch is decided here.
 *
 *  3. **An archived document still accepts comments.** `assertWritable` in
 *     DocumentsService is deliberately not applied: archiving freezes what the
 *     document IS, not the conversation about it. A trashed document is
 *     different — it reads as gone everywhere, including here.
 */
@Injectable()
export class CommentsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly notifications: NotificationsService,
    private readonly events: EventsService,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A document's thread, oldest first.
   *
   * Oldest-first because a discussion is read from the top — unlike the
   * notification inbox, where only the newest matters and the cursor walks
   * backwards. `@@index([companyId, documentId, createdAt])` serves it directly.
   *
   * `total` counts what this endpoint would return, so a "3 comments" badge and
   * the thread itself cannot disagree about deleted ones.
   */
  async forDocument(documentId: string, dto: ListCommentsDto) {
    await this.mustFindDocument(documentId);

    const limit = dto.limit ?? DEFAULT_COMMENT_PAGE_SIZE;
    const where = { documentId, deletedAt: null };

    const [rows, total] = await Promise.all([
      this.db.comment.findMany({
        where,
        select: COMMENT_VIEW,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        // One extra row answers "is there another page?" without a second count.
        take: limit + 1,
        ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
      }),
      this.db.comment.count({ where }),
    ]);

    const items = rows.slice(0, limit);

    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
      total,
    };
  }

  async create(
    documentId: string,
    dto: CreateCommentDto,
    userId: string,
    companyId: string,
    context: RequestContext,
  ) {
    const document = await this.mustFindDocument(documentId);

    /**
     * Read BEFORE the insert, so the list means "who was already here". Read
     * after, it would always contain the author — leaving `createMany`'s
     * exceptUserId as the only thing standing between someone and a
     * notification about their own remark, rather than a second line of defence.
     */
    const recipients = await this.participants(documentId, document.ownerId);

    const comment = await this.db.comment.create({
      data: tenantCreate({ documentId, authorId: userId, body: dto.body }),
      select: COMMENT_VIEW,
    });

    await this.audit.record({
      action: 'comment.create',
      entityType: 'Comment',
      entityId: comment.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      // The body is not copied here — the row itself holds it, and a soft delete
      // leaves it readable. Duplicating it would put the same text in two places
      // with only one of them ever being redacted.
      metadata: { documentId, name: document.name },
    });

    await this.notifications.createMany(
      recipients,
      {
        type: NotificationType.DOCUMENT_COMMENTED,
        actorId: userId,
        entityType: 'Document',
        entityId: documentId,
        payload: { name: document.name, documentId, commentId: comment.id },
      },
      // Never tell someone about their own remark.
      userId,
    );

    await this.announce(companyId, recipients, documentId, comment.id, userId);

    return comment;
  }

  /**
   * Rewrites a comment's body. Only its author, ever.
   *
   * A moderator holding `comments.moderate` cannot edit — that permission is
   * "delete anyone's comment", and putting different words in someone's mouth is
   * not moderation. `editedAt` is set so the UI can mark the change: silently
   * rewriting text someone has already replied to is how a thread starts lying.
   */
  async update(
    id: string,
    dto: UpdateCommentDto,
    userId: string,
    companyId: string,
    context: RequestContext,
  ) {
    const comment = await this.mustFind(id);

    if (comment.authorId !== userId) {
      throw new ForbiddenException(
        apiError(ERROR_CODES.COMMENT_NOT_AUTHOR, 'You can only edit your own comments'),
      );
    }

    // Re-sending the same text is not an edit. Marking it as one would put an
    // "edited" label on a comment nobody changed.
    if (comment.body === dto.body) {
      return this.mustFindView(id);
    }

    const updated = await this.db.comment.update({
      where: { id },
      data: { body: dto.body, editedAt: new Date() },
      select: COMMENT_VIEW,
    });

    await this.audit.record({
      action: 'comment.update',
      entityType: 'Comment',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { documentId: comment.documentId, name: comment.document.name },
    });

    // No notification: an edit is not news, and re-announcing it to the thread
    // would make a typo fix as loud as a new remark. The live event still fires
    // so an open thread shows the new text.
    await this.announce(companyId, [], comment.documentId, id, userId);

    return updated;
  }

  /**
   * Soft-deletes a comment.
   *
   * The author may remove their own. Anyone else needs `comments.moderate`,
   * checked here rather than at the route because the guard cannot express an
   * either/or. The row survives with `deletedAt` set — "who deleted what" is a
   * problem this product exists to answer, and that includes what was said.
   */
  async remove(id: string, userId: string, companyId: string, context: RequestContext) {
    const comment = await this.mustFind(id);
    const moderated = comment.authorId !== userId;

    if (moderated) {
      const granted = await this.permissions.effectiveFor(userId);

      if (!granted.has('comments.moderate')) {
        throw new ForbiddenException(
          apiError(ERROR_CODES.PERMISSION_DENIED, 'You can only delete your own comments', {
            permissions: 'comments.moderate',
          }),
        );
      }
    }

    /**
     * Conditioned on `deletedAt: null` inside the UPDATE. `mustFind` already
     * filtered it, but two deletes racing would both pass that check and the
     * second would move the timestamp — rewriting when the comment was removed.
     */
    await this.db.comment.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    await this.audit.record({
      action: 'comment.delete',
      entityType: 'Comment',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      // `moderated` is the part worth being able to search for later: someone
      // deleting their own remark and someone deleting a colleague's are
      // different events wearing the same action name.
      metadata: {
        documentId: comment.documentId,
        name: comment.document.name,
        authorId: comment.authorId,
        moderated,
      },
    });

    await this.announce(companyId, [], comment.documentId, id, userId);

    return { id };
  }

  /**
   * Who has a stake in this document: its owner, and everyone already in the
   * conversation.
   *
   * Not "everyone in the company" — a comment is a remark on one document, and
   * broadcasting it would make the bell useless within a week. The owner may
   * also be a prior author; `createMany` dedupes, so both may appear here.
   */
  private async participants(documentId: string, ownerId: string): Promise<string[]> {
    const authors = await this.db.comment.findMany({
      where: { documentId, deletedAt: null },
      select: { authorId: true },
      distinct: ['authorId'],
    });

    return [ownerId, ...authors.map((row) => row.authorId)];
  }

  /**
   * Pushes the change to anyone watching.
   *
   * Two events, as in ApprovalsService: `comment.changed` goes to the whole
   * company so an open document view refetches its thread, while the unread
   * count is addressed to each recipient individually. The broadcast carries
   * only ids — the thread endpoint has the permission check behind it.
   */
  private async announce(
    companyId: string,
    recipients: string[],
    documentId: string,
    commentId: string,
    actorId: string,
  ): Promise<void> {
    await this.events.publish({
      companyId,
      event: { type: 'comment.changed', documentId, commentId },
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

  /**
   * The document the thread hangs off.
   *
   * Trashed reads as gone. Archived does not: see the class comment.
   */
  private async mustFindDocument(documentId: string) {
    const document = await this.db.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, name: true, ownerId: true },
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    return document;
  }

  /**
   * A live comment, with the fields the authorisation checks need.
   *
   * `findFirst`, so the tenant guard filters before execution — `PATCH`/`DELETE
   * /api/comments/:id` route on a bare id with no document in the path, which is
   * exactly why Comment carries its own companyId instead of reaching the tenant
   * through its document.
   *
   * A soft-deleted comment is not found. There is nothing left to edit, and
   * re-deleting it would only move the timestamp.
   */
  private async mustFind(id: string) {
    const comment = await this.db.comment.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        authorId: true,
        documentId: true,
        body: true,
        document: { select: { name: true } },
      },
    });

    if (!comment) {
      throw new NotFoundException(
        apiError(ERROR_CODES.COMMENT_NOT_FOUND, 'That comment does not exist'),
      );
    }

    return comment;
  }

  private async mustFindView(id: string) {
    const comment = await this.db.comment.findFirst({
      where: { id, deletedAt: null },
      select: COMMENT_VIEW,
    });

    if (!comment) {
      throw new NotFoundException(
        apiError(ERROR_CODES.COMMENT_NOT_FOUND, 'That comment does not exist'),
      );
    }

    return comment;
  }
}
