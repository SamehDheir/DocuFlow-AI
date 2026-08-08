import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DocumentStatus } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import type { RequestContext } from '../common/http/request-context';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { tenantCreate, type TenantGuardedClient } from '../prisma/tenant-guard';
import type { CreateTagDto, SetDocumentTagsDto, UpdateTagDto } from './dto/tag.dto';

const TAG_SUMMARY = {
  id: true,
  name: true,
  color: true,
  createdAt: true,
} as const;

export interface TagSummary {
  id: string;
  name: string;
  color: string | null;
  createdAt: Date;
}

export type TagListItem = TagSummary & { documentCount: number };

/**
 * Tags — the labelling layer from spec §12.
 *
 * `Tag` and `DocumentTag` were in the schema from the very first migration and
 * had no code behind them at all until now: no module, no route, no UI. They
 * were registered with the tenant guard and otherwise dead.
 */
@Injectable()
export class TagsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * The company's whole vocabulary, with usage counts.
   *
   * Returned flat and unpaginated: a tag list that needs paging is a tag list
   * nobody can use as a filter, and the `@@unique([companyId, name])` keeps it
   * bounded by how many distinct labels a company has bothered to invent.
   *
   * The count excludes trashed and archived documents so it agrees with the
   * list the tag filters — the same rule the folder counts follow.
   */
  async list(): Promise<TagListItem[]> {
    const rows = await this.db.tag.findMany({
      select: {
        ...TAG_SUMMARY,
        _count: {
          select: {
            documents: {
              where: { document: { deletedAt: null, status: { not: DocumentStatus.ARCHIVED } } },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return rows.map(({ _count, ...tag }) => ({ ...tag, documentCount: _count.documents }));
  }

  async create(dto: CreateTagDto, context: RequestContext): Promise<TagSummary> {
    await this.assertNameAvailable(dto.name);

    const tag = await this.db.tag.create({
      data: tenantCreate({ name: dto.name, color: dto.color ?? null }),
      select: TAG_SUMMARY,
    });

    await this.audit.record({
      action: 'tag.create',
      entityType: 'Tag',
      entityId: tag.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: tag.name, color: tag.color },
    });

    return tag;
  }

  async update(id: string, dto: UpdateTagDto, context: RequestContext): Promise<TagSummary> {
    const tag = await this.mustFind(id);

    if (dto.name !== undefined && dto.name !== tag.name) {
      await this.assertNameAvailable(dto.name, id);
    }

    const updated = await this.db.tag.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.color === undefined ? {} : { color: dto.color }),
      },
      select: TAG_SUMMARY,
    });

    await this.audit.record({
      action: 'tag.update',
      entityType: 'Tag',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      // Renaming a tag relabels every document carrying it, so the old name is
      // worth keeping — it is the only record of what those documents said.
      metadata: { from: tag.name, to: updated.name, color: updated.color },
    });

    return updated;
  }

  /**
   * Deletes a tag and, by cascade, every document's link to it.
   *
   * No "tag still in use" refusal, unlike an occupied folder. A folder is where
   * a document LIVES and deleting one would strand its contents; a tag is a
   * label, and removing it leaves every document exactly where it was. The
   * count in the response is what tells the caller how much was unlabelled, so
   * the UI can say so before asking for confirmation.
   */
  async remove(id: string, context: RequestContext): Promise<{ id: string; unlabelled: number }> {
    const tag = await this.mustFind(id);

    const unlabelled = await this.db.documentTag.count({ where: { tagId: id } });

    await this.db.tag.delete({ where: { id } });

    await this.audit.record({
      action: 'tag.delete',
      entityType: 'Tag',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: tag.name, unlabelled },
    });

    return { id, unlabelled };
  }

  /**
   * Replaces a document's tags with exactly the set given.
   *
   * Written as a nested update through the scoped parent. `DocumentTag` carries
   * no companyId, so the guard leaves a direct `documentTag.deleteMany({ where:
   * { documentId } })` completely unfiltered — with a document id from the URL,
   * that would happily clear another tenant's labels.
   */
  async setForDocument(
    documentId: string,
    dto: SetDocumentTagsDto,
    context: RequestContext,
  ): Promise<TagSummary[]> {
    const document = await this.db.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: {
        id: true,
        name: true,
        status: true,
        tags: { select: { tag: { select: TAG_SUMMARY } } },
      },
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    if (document.status === DocumentStatus.ARCHIVED) {
      throw new ConflictException(
        apiError(
          ERROR_CODES.DOCUMENT_ARCHIVED,
          'That document is archived. Restore it before making changes.',
        ),
      );
    }

    const wanted = [...new Set(dto.tagIds)];

    /**
     * Every id is resolved before anything is written, and the read is
     * tenant-scoped — so an id belonging to another company simply does not
     * come back and the whole call fails. Letting the nested `create` discover
     * it instead would surface a raw foreign-key violation as a 500.
     */
    const tags = await this.db.tag.findMany({
      where: { id: { in: wanted } },
      select: TAG_SUMMARY,
    });

    if (tags.length !== wanted.length) {
      throw new NotFoundException(apiError(ERROR_CODES.TAG_NOT_FOUND, 'That tag does not exist'));
    }

    const before = new Set(document.tags.map((link) => link.tag.id));
    const after = new Set(wanted);

    await this.db.document.update({
      where: { id: documentId },
      data: {
        tags: {
          // Whole-set replacement: clear, then write what was asked for.
          deleteMany: {},
          create: wanted.map((tagId) => ({ tagId })),
        },
      },
      select: { id: true },
    });

    const added = wanted.filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));

    // Nothing changed — no audit row for a no-op re-send of the same set.
    if (added.length > 0 || removed.length > 0) {
      await this.audit.record({
        action: 'document.tags.set',
        entityType: 'Document',
        entityId: documentId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { name: document.name, added, removed },
      });
    }

    // Returned in the same order the vocabulary lists them, not the order the
    // caller happened to send.
    return tags.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async mustFind(id: string): Promise<TagSummary> {
    const tag = await this.db.tag.findFirst({ where: { id }, select: TAG_SUMMARY });

    if (!tag) {
      throw new NotFoundException(apiError(ERROR_CODES.TAG_NOT_FOUND, 'That tag does not exist'));
    }

    return tag;
  }

  /**
   * Checked up front rather than left to the `@@unique([companyId, name])`.
   *
   * The constraint is still the real guarantee — two simultaneous creates race
   * past this and one gets a P2002, which PrismaExceptionFilter turns into a
   * 409. This exists so the ordinary case carries a field-level message the
   * form can put under the input.
   */
  private async assertNameAvailable(name: string, excludeId?: string): Promise<void> {
    const clash = await this.db.tag.findFirst({
      where: { name, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });

    if (clash) {
      throw new ConflictException(
        apiError(ERROR_CODES.TAG_NAME_TAKEN, 'A tag with this name already exists', {
          name: 'A tag with this name already exists',
        }),
      );
    }
  }
}
