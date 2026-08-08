import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentStatus, NotificationType, type Prisma } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import type { RequestContext } from '../common/http/request-context';
import type { Env } from '../config/env.validation';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { tenantCreate, type TenantGuardedClient } from '../prisma/tenant-guard';
import { DocumentProcessingProducer } from '../queue/document-processing.producer';
import { StorageService } from '../storage/storage.service';
import { buildStorageKey, extensionOf } from '../storage/storage-key';
import { NotificationsService } from '../notifications/notifications.service';
import { ACTIVE, IN_FLIGHT } from './document-rules';
import type { AddVersionDto } from './dto/add-version.dto';
import { DEFAULT_PAGE_SIZE, type ListDocumentsDto } from './dto/list-documents.dto';
import type { UpdateDocumentDto } from './dto/update-document.dto';
import type { UploadDocumentDto } from './dto/upload-document.dto';

/** Types safe to render inline. Everything else downloads as an attachment. */
/**
 * Types streamed inline for the preview pane.
 *
 * `text/plain` is here because the response is already hardened for exactly
 * this case: `X-Content-Type-Options: nosniff` stops a text file being
 * re-interpreted as HTML, and `Content-Security-Policy: sandbox; default-src
 * 'none'` neuters anything that survives. The web additionally re-wraps the
 * blob with a type from its own allowlist rather than trusting the response.
 *
 * Office formats are deliberately NOT here — a browser cannot render them, so
 * streaming the bytes would just download them. The UI previews those from
 * `DocumentMetadata.extractedText` instead, which v2 fills in for every one.
 */
const INLINE_PREVIEWABLE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

const DOCUMENT_SUMMARY = {
  id: true,
  name: true,
  originalName: true,
  mimeType: true,
  extension: true,
  size: true,
  status: true,
  folderId: true,
  ownerId: true,
  hash: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.DocumentSelect;

type DocumentRow = Prisma.DocumentGetPayload<{ select: typeof DOCUMENT_SUMMARY }>;

/**
 * The list projection: everything in the summary, plus just enough processing
 * state to render a status badge per row.
 *
 * Only the two enums and the page count — deliberately not `extractedText` or
 * `summary`. A page of 20 scanned contracts would otherwise ship megabytes of
 * OCR text to draw twenty badges.
 *
 * Tags ARE included, unlike the heavy metadata, because `?tagId=` filters on
 * them: a browser that can narrow to a label but never shows which labels a row
 * carries leaves the filter undiscoverable, and the reader with no way to tell
 * why a document matched. Three short columns off a join that is already indexed
 * is a different order of cost from a page of OCR text. Same reasoning as
 * versions for reaching them through the parent — DocumentTag has no companyId.
 */
const DOCUMENT_LIST = {
  ...DOCUMENT_SUMMARY,
  metadata: { select: { ocrStatus: true, aiStatus: true, ocrPages: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
} satisfies Prisma.DocumentSelect;

/** What multer hands over after writing the upload to a temp file. */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
}

/**
 * `size` is a BigInt in the schema — a 32-bit int caps out around 2.1 GB, which
 * a scanned archive can exceed. BigInt does not survive JSON.stringify, so it
 * is widened to a string at this boundary rather than left to blow up in the
 * serialiser.
 */
export type DocumentView = Omit<DocumentRow, 'size'> & { size: string };

/** A label as the client wants it — the tag itself, not the join row. */
export interface TagRef {
  id: string;
  name: string;
  color: string | null;
}

/** A row in the browser: the file, the caller's star, and its labels. */
export type DocumentListItem = DocumentView & { isFavorite: boolean; tags: TagRef[] };

/**
 * The caller's own favourite row, if there is one.
 *
 * Selected rather than counted: `@@id([userId, documentId])` means this matches
 * at most once, so presence IS the boolean. Reached as a nested read through
 * Document so it rides the parent's tenant predicate — the same reason tags and
 * versions are never queried by a bare id.
 */
const MINE = (userId: string) =>
  ({ where: { userId }, select: { userId: true } }) satisfies Prisma.Document$favoritesArgs;

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly maxFileSize: number;
  private readonly allowedMimeTypes: Set<string>;

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly processing: DocumentProcessingProducer,
    private readonly notifications: NotificationsService,
    config: ConfigService<Env, true>,
  ) {
    this.maxFileSize = config.get('MAX_FILE_SIZE', { infer: true });
    this.allowedMimeTypes = new Set(config.get('ALLOWED_MIME_TYPES', { infer: true }));
  }

  /**
   * The upload pipeline.
   *
   * multer has already written the body to a temp file, so size and hash are
   * known before anything is committed. The order below is chosen so that no
   * failure can leave a row pointing at bytes that are not there:
   *
   *   1. validate             — cheapest rejections first, before any write
   *   2. row at UPLOADING     — a visible, sweepable state, not a silent orphan
   *   3. bytes to MinIO
   *   4. row to PROCESSING + version #1 + audit
   *   5. enqueue, AFTER the transaction commits
   *
   * A crash between 2 and 4 leaves the document at UPLOADING, which the UI can
   * show as a failed upload and an operator can reap. That is strictly better
   * than the alternative ordering, where a crash leaves an object in the bucket
   * that nothing in the database references.
   *
   * Step 5 was the v1 seam and is now real: the request returns as soon as the
   * bytes are safe, and PROCESSING → OCR → AI_ANALYSIS → READY runs on a queue
   * worker. It happens strictly AFTER commit, because Redis and Postgres share
   * no transaction — a job enqueued inside the transaction can be picked up
   * before the row it names is visible to another connection.
   */
  async upload(
    file: UploadedFile,
    dto: UploadDocumentDto,
    userId: string,
    context: RequestContext,
    companyId: string,
  ): Promise<DocumentView> {
    try {
      this.assertAcceptable(file);

      if (dto.folderId) {
        await this.assertFolderExists(dto.folderId);
      }

      const extension = extensionOf(file.originalname);
      const storageKey = buildStorageKey(companyId, extension);
      const hash = await hashFile(file.path);

      const created = await this.db.document.create({
        data: tenantCreate({
          name: dto.name ?? file.originalname,
          originalName: file.originalname,
          mimeType: file.mimetype,
          extension,
          size: BigInt(file.size),
          storageKey,
          hash,
          status: DocumentStatus.UPLOADING,
          ownerId: userId,
          folderId: dto.folderId ?? null,
          ...(dto.description ? { metadata: { create: { description: dto.description } } } : {}),
        }),
        select: DOCUMENT_SUMMARY,
      });

      try {
        await this.storage.putFile(storageKey, file.path, file.mimetype);
      } catch (error) {
        // The row stays at UPLOADING on purpose — see the note above.
        this.logger.error(`Upload of document ${created.id} failed at the storage step`, error);
        throw error;
      }

      const stored = await this.db.$transaction(async (tx) => {
        const updated = await tx.document.update({
          where: { id: created.id },
          data: { status: DocumentStatus.PROCESSING },
          select: DOCUMENT_SUMMARY,
        });

        /**
         * Version 1 exists from the first upload.
         *
         * A document is an aggregate, not a row (§11), and re-uploading appends
         * a version rather than overwriting. Writing #1 now means the history
         * is never missing its own beginning — and each version points at its
         * OWN immutable key, which is why the bucket has versioning enabled.
         */
        await tx.documentVersion.create({
          data: {
            documentId: created.id,
            versionNumber: 1,
            storageKey,
            size: BigInt(file.size),
            hash,
            // Recorded per version so a later revert restores the type and
            // filename, not just the bytes.
            mimeType: file.mimetype,
            originalName: file.originalname,
            uploadedById: userId,
          },
        });

        await this.audit.record(
          {
            action: 'document.upload',
            entityType: 'Document',
            entityId: created.id,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: {
              name: updated.name,
              size: file.size,
              mimeType: file.mimetype,
              folderId: updated.folderId,
            },
          },
          tx,
        );

        return updated;
      });

      /**
       * After commit, never inside it — see the note on the pipeline above.
       *
       * A refused enqueue is not an upload failure. The bytes are stored and
       * the row is committed; the document simply sits at PROCESSING until
       * someone reprocesses it, which is visible in the UI and recoverable.
       */
      await this.processing.enqueue({
        documentId: stored.id,
        companyId,
        userId,
      });

      return toView(stored);
    } finally {
      // Always: the temp file is a copy of bytes now living in MinIO, and
      // leaving it behind fills the disk one upload at a time.
      await unlink(file.path).catch(() => undefined);
    }
  }

  /**
   * A page of documents, newest first.
   *
   * Cursor pagination rather than offset: `@@index([companyId, createdAt])`
   * already exists and is composite with companyId first, and an offset scan
   * degrades exactly where this has to hold up — deep into a large archive.
   */
  /**
   * `userId` is here only because a favourite is private to one person.
   *
   * It is the caller's own id from the verified JWT, never a query parameter —
   * `?userId=` would turn "my shortlist" into "anyone's shortlist" for every
   * colleague in the company, which the tenant guard cannot see and would not
   * stop. `ownerId` below is the opposite kind of field and is filterable.
   */
  async list(
    dto: ListDocumentsDto,
    userId: string,
  ): Promise<{ items: DocumentListItem[]; nextCursor: string | null }> {
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    const inTrash = dto.trash === 'true';

    const where: Prisma.DocumentWhereInput = {
      ...(inTrash ? { deletedAt: { not: null } } : ACTIVE),
      ...(dto.folderId === undefined
        ? {}
        : { folderId: dto.folderId === '' ? null : dto.folderId }),
      /**
       * Archived documents are hidden unless asked for.
       *
       * Spelled out here rather than folded into ACTIVE, because the two
       * exclusions are different in kind: `deletedAt` is a soft delete that
       * every read must honour, while this one is a default a caller may
       * legitimately turn off. Asking for `?status=ARCHIVED` wins outright —
       * otherwise the one filter that names the archive would return nothing.
       */
      ...(dto.status
        ? { status: dto.status }
        : inTrash || dto.includeArchived === 'true'
          ? {}
          : { status: { not: DocumentStatus.ARCHIVED } }),
      ...(dto.mimeType ? { mimeType: dto.mimeType } : {}),
      ...(dto.ownerId ? { ownerId: dto.ownerId } : {}),
      /**
       * Reached through the relation, not by querying DocumentTag directly:
       * that join model carries no companyId, so the guard would not scope it.
       * As a nested filter on Document it rides on the parent's tenant filter.
       */
      ...(dto.tagId ? { tags: { some: { tagId: dto.tagId } } } : {}),
      /**
       * Pinned to the caller, so this reads as "my favourites" and cannot be
       * asked any other way. The relation filter rides on the parent's tenant
       * predicate, exactly as the tag one does.
       */
      ...(dto.favorite === 'true' ? { favorites: { some: { userId } } } : {}),
      ...(dto.q ? { name: { contains: dto.q, mode: 'insensitive' as const } } : {}),
    };

    // One extra row is fetched purely to answer "is there another page?"
    // without a second count query.
    const rows = await this.db.document.findMany({
      where,
      select: { ...DOCUMENT_LIST, favorites: MINE(userId) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });

    const items = rows.slice(0, limit);

    return {
      items: items.map(toRowView),
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  /** Totals for the dashboard. */
  async stats(): Promise<{ documents: number; storageBytes: string; trashed: number }> {
    const [documents, aggregate, trashed] = await Promise.all([
      this.db.document.count({ where: ACTIVE }),
      this.db.document.aggregate({ where: ACTIVE, _sum: { size: true } }),
      this.db.document.count({ where: { deletedAt: { not: null } } }),
    ]);

    return {
      documents,
      storageBytes: (aggregate._sum.size ?? BigInt(0)).toString(),
      trashed,
    };
  }

  async findOne(id: string, userId: string) {
    const document = await this.db.document.findFirst({
      where: { id },
      select: {
        ...DOCUMENT_SUMMARY,
        favorites: MINE(userId),
        metadata: {
          select: {
            title: true,
            description: true,
            language: true,
            keywords: true,
            /**
             * The v2 payload. `extractedText` can be megabytes, so it is served
             * only here — on the detail view someone deliberately opened — and
             * never from the list endpoint.
             */
            summary: true,
            extractedText: true,
            ocrStatus: true,
            ocrError: true,
            ocrPages: true,
            aiStatus: true,
            aiError: true,
            aiModel: true,
          },
        },
        /**
         * Versions are reached through their parent on purpose.
         *
         * DocumentVersion carries no companyId of its own, so the tenant guard
         * passes it through unfiltered — querying `documentVersion` directly
         * with a raw id would escape tenant isolation entirely.
         */
        versions: {
          select: {
            id: true,
            versionNumber: true,
            size: true,
            createdAt: true,
            uploadedById: true,
            /**
             * v4. A history that lists only sizes and dates cannot answer the
             * question it exists for — what changed, and by whom. `note` is the
             * uploader's own words, `originalName` is what the file was called
             * at that point (a .docx replaced by a .pdf reads as two different
             * documents without it), and the uploader is joined rather than left
             * as a bare id the client would have to resolve per row.
             */
            originalName: true,
            mimeType: true,
            note: true,
            uploadedBy: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { versionNumber: 'desc' },
        },
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        folder: { select: { id: true, name: true } },
        // Same reasoning as versions: DocumentTag has no companyId, so it is
        // only ever reached through the scoped parent.
        tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
      },
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    return {
      ...toFavoriteView(document),
      metadata: document.metadata,
      owner: document.owner,
      folder: document.folder,
      versions: document.versions.map((version) => ({
        ...version,
        size: version.size.toString(),
      })),
      // Flattened out of the join rows: the client wants tags, not links.
      tags: flattenTags(document.tags),
    };
  }

  /** Opens the stored bytes for streaming, and records that it happened. */
  async openForDownload(
    id: string,
    context: RequestContext,
    { inline }: { inline: boolean },
  ): Promise<{ stream: Readable; document: DocumentRow & { storageKey: string } }> {
    const document = await this.db.document.findFirst({
      where: { id, ...ACTIVE },
      select: { ...DOCUMENT_SUMMARY, storageKey: true },
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    if (inline && !INLINE_PREVIEWABLE.has(document.mimeType)) {
      throw new BadRequestException(
        apiError(ERROR_CODES.PREVIEW_NOT_AVAILABLE, 'This file type cannot be previewed'),
      );
    }

    const stream = await this.storage.getStream(document.storageKey);

    await this.audit.record({
      action: inline ? 'document.preview' : 'document.download',
      entityType: 'Document',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: document.name },
    });

    return { stream, document };
  }

  async update(id: string, dto: UpdateDocumentDto, context: RequestContext): Promise<DocumentView> {
    const document = await this.mustFindActive(id);

    this.assertWritable(document);

    if (dto.folderId) {
      await this.assertFolderExists(dto.folderId);
    }

    const hasMetadata = dto.title !== undefined || dto.description !== undefined;

    const updated = await this.db.document.update({
      where: { id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.folderId === undefined ? {} : { folderId: dto.folderId }),
        /**
         * Nested upsert through the scoped parent.
         *
         * The tenant guard sees this as `Document.update` and scopes it
         * normally. A direct `documentMetadata.upsert` would not be scoped —
         * DocumentMetadata carries no companyId — and the guard now refuses an
         * unscoped upsert outright rather than letting it through.
         */
        ...(hasMetadata
          ? {
              metadata: {
                upsert: {
                  create: { title: dto.title, description: dto.description },
                  update: {
                    ...(dto.title === undefined ? {} : { title: dto.title }),
                    ...(dto.description === undefined ? {} : { description: dto.description }),
                  },
                },
              },
            }
          : {}),
      },
      select: DOCUMENT_SUMMARY,
    });

    if (dto.name !== undefined && dto.name !== document.name) {
      await this.audit.record({
        action: 'document.rename',
        entityType: 'Document',
        entityId: id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { from: document.name, to: dto.name },
      });
    }

    if (dto.folderId !== undefined && dto.folderId !== document.folderId) {
      await this.audit.record({
        action: 'document.move',
        entityType: 'Document',
        entityId: id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { from: document.folderId, to: dto.folderId },
      });
    }

    return toView(updated);
  }

  /**
   * Soft delete.
   *
   * The row is never removed and the object is never deleted, because Restore
   * is a v1 feature (§12) and "who deleted this file, and can we get it back"
   * is the question the product exists to answer.
   */
  async remove(id: string, context: RequestContext): Promise<DocumentView> {
    const document = await this.mustFindActive(id);

    const deleted = await this.db.document.update({
      where: { id },
      data: { deletedAt: new Date(), status: DocumentStatus.DELETED },
      select: DOCUMENT_SUMMARY,
    });

    await this.audit.record({
      action: 'document.delete',
      entityType: 'Document',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: document.name, folderId: document.folderId },
    });

    return toView(deleted);
  }

  async restore(id: string, context: RequestContext): Promise<DocumentView> {
    const document = await this.db.document.findFirst({
      where: { id },
      select: { ...DOCUMENT_SUMMARY, folder: { select: { id: true } } },
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    if (!document.deletedAt) {
      throw new ConflictException(
        apiError(ERROR_CODES.DOCUMENT_NOT_DELETED, 'That document is not in the trash'),
      );
    }

    const restored = await this.db.document.update({
      where: { id },
      data: {
        deletedAt: null,
        status: DocumentStatus.READY,
        // The folder may have been deleted while this sat in the trash. The
        // schema nulls folderId on folder delete, so this is belt-and-braces
        // for the case where the row was written before that cascade ran.
        ...(document.folder ? {} : { folderId: null }),
      },
      select: DOCUMENT_SUMMARY,
    });

    await this.audit.record({
      action: 'document.restore',
      entityType: 'Document',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: document.name },
    });

    return toView(restored);
  }

  /**
   * Puts a document back through OCR and AI analysis.
   *
   * Serves three jobs at once, which is why it is one endpoint rather than
   * three: retrying a step that failed, backfilling documents uploaded before
   * v2 existed (their metadata sits at PENDING), and re-running analysis after
   * the model or the prompt changes.
   */
  async reprocess(
    id: string,
    userId: string,
    companyId: string,
    context: RequestContext,
  ): Promise<DocumentView> {
    const document = await this.mustFindActive(id);

    /**
     * Refused on an archived document, and this is what stops archiving from
     * silently undoing itself: the pipeline ends with an unconditional advance
     * to READY, so a reprocess of an archived document would un-archive it.
     */
    this.assertWritable(document);
    this.assertNotInFlight(document);

    /**
     * Clear the finished job first. The document id doubles as the BullMQ job
     * id to collapse double-submits, and a retained completed job would make
     * this add() a silent no-op.
     */
    await this.processing.forget(document.id);

    const updated = await this.db.document.update({
      where: { id },
      data: {
        status: DocumentStatus.PROCESSING,
        metadata: {
          upsert: {
            // Reset both steps so the UI shows work restarting rather than the
            // previous run's stale outcome.
            create: { ocrStatus: 'QUEUED', aiStatus: 'PENDING' },
            update: { ocrStatus: 'QUEUED', ocrError: null, aiStatus: 'PENDING', aiError: null },
          },
        },
      },
      select: DOCUMENT_SUMMARY,
    });

    const queued = await this.processing.enqueue({
      documentId: id,
      companyId,
      userId,
      reprocess: true,
    });

    if (!queued) {
      throw new ServiceUnavailableException(
        apiError(
          ERROR_CODES.PROCESSING_UNAVAILABLE,
          'Processing is unavailable right now. Try again shortly.',
        ),
      );
    }

    await this.audit.record({
      action: 'document.reprocess.request',
      entityType: 'Document',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: document.name },
    });

    return toView(updated);
  }

  /**
   * Appends a new version and makes it the document's current bytes.
   *
   * Follows the upload pipeline's ordering exactly (see `upload` above), because
   * the failure modes are the same: bytes reach MinIO before any row points at
   * them, and the enqueue happens strictly after the commit.
   *
   * The one addition is unwinding. `upload` can leave its row at UPLOADING for
   * an operator to reap, but here the document already exists and is perfectly
   * good — so a failed transaction must take the orphaned object with it rather
   * than leave the previous version's row beside bytes nothing references.
   */
  async addVersion(
    id: string,
    file: UploadedFile,
    dto: AddVersionDto,
    userId: string,
    companyId: string,
    context: RequestContext,
  ): Promise<DocumentView> {
    try {
      this.assertAcceptable(file);

      const document = await this.mustFindActive(id);
      this.assertWritable(document);
      this.assertNotInFlight(document);

      const extension = extensionOf(file.originalname);
      const storageKey = buildStorageKey(companyId, extension);
      const hash = await hashFile(file.path);

      await this.storage.putFile(storageKey, file.path, file.mimetype);

      /**
       * Before the enqueue below, and before the transaction so a failure does
       * not leave a cleared job with no new one behind it. The document id
       * doubles as the BullMQ job id, so a retained completed job would make
       * the add() a silent no-op: the row would sit at PROCESSING forever and
       * the new bytes would never be extracted.
       */
      await this.processing.forget(id);

      let stored: DocumentRow;

      try {
        stored = await this.replaceCurrentBytes(id, {
          storageKey,
          size: BigInt(file.size),
          hash,
          mimeType: file.mimetype,
          extension,
          originalName: file.originalname,
          note: dto.note,
          userId,
          audit: {
            action: 'document.version.add',
            context,
            extra: { name: document.name, size: file.size, mimeType: file.mimetype },
          },
        });
      } catch (error) {
        await this.storage.removeQuietly(storageKey);
        throw error;
      }

      await this.processing.enqueue({ documentId: id, companyId, userId, reprocess: true });

      await this.announceNewVersion(document.ownerId, userId, id, document.name);

      return toView(stored);
    } finally {
      await unlink(file.path).catch(() => undefined);
    }
  }

  /**
   * Restores an earlier version by appending it as a new one.
   *
   * History is never rewritten and the pointer is never moved backwards. Two
   * reasons: `document_versions.storage_key` is unique, so no two rows may name
   * one object — and an audit trail you can rewind is not an audit trail. After
   * reverting v3 to v1 the document has four versions, and v4 says where its
   * bytes came from.
   */
  async revertToVersion(
    id: string,
    versionId: string,
    dto: AddVersionDto,
    userId: string,
    companyId: string,
    context: RequestContext,
  ): Promise<DocumentView> {
    const found = await this.db.document.findFirst({
      where: { id, ...ACTIVE },
      select: {
        ...DOCUMENT_SUMMARY,
        // Reached through the parent: DocumentVersion has no companyId of its
        // own, so a direct query on a client-supplied version id would escape
        // tenant isolation entirely.
        versions: {
          where: { id: versionId },
          select: {
            versionNumber: true,
            storageKey: true,
            size: true,
            hash: true,
            mimeType: true,
            originalName: true,
          },
        },
      },
    });

    if (!found) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    this.assertWritable(found);
    this.assertNotInFlight(found);

    const target = found.versions[0];

    if (!target) {
      throw new NotFoundException(
        apiError(ERROR_CODES.VERSION_NOT_FOUND, 'That version does not exist'),
      );
    }

    const storageKey = buildStorageKey(companyId, extensionOf(target.originalName));

    // Copied server-side inside MinIO, so the bytes never pass through this
    // process — reverting a 100 MB scan costs no memory here.
    await this.storage.copyObject(target.storageKey, storageKey);

    await this.processing.forget(id);

    let stored: DocumentRow;

    try {
      stored = await this.replaceCurrentBytes(id, {
        storageKey,
        size: target.size,
        hash: target.hash,
        mimeType: target.mimeType,
        extension: extensionOf(target.originalName),
        originalName: target.originalName,
        note: dto.note,
        userId,
        audit: {
          action: 'document.version.revert',
          context,
          extra: { name: found.name, fromVersion: target.versionNumber },
        },
      });
    } catch (error) {
      await this.storage.removeQuietly(storageKey);
      throw error;
    }

    await this.processing.enqueue({ documentId: id, companyId, userId, reprocess: true });

    await this.announceNewVersion(found.ownerId, userId, id, found.name);

    return toView(stored);
  }

  /** Opens one historical version's bytes. The document is the tenant check. */
  async openVersionForDownload(
    id: string,
    versionId: string,
    context: RequestContext,
  ): Promise<{
    stream: Readable;
    version: { versionNumber: number; size: bigint; mimeType: string; originalName: string };
  }> {
    const document = await this.db.document.findFirst({
      where: { id, ...ACTIVE },
      select: {
        id: true,
        name: true,
        versions: {
          where: { id: versionId },
          select: {
            versionNumber: true,
            storageKey: true,
            size: true,
            mimeType: true,
            originalName: true,
          },
        },
      },
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    const version = document.versions[0];

    if (!version) {
      throw new NotFoundException(
        apiError(ERROR_CODES.VERSION_NOT_FOUND, 'That version does not exist'),
      );
    }

    const stream = await this.storage.getStream(version.storageKey);

    await this.audit.record({
      action: 'document.version.download',
      entityType: 'Document',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: document.name, versionNumber: version.versionNumber },
    });

    return { stream, version };
  }

  /**
   * Freezes a document out of the active listing without deleting it.
   *
   * Archive is a status, so it survives nothing else: `remove()` overwrites
   * status with DELETED and `restore()` unconditionally sets READY, which means
   * archiving is lost across a trip through the trash. Preserving it would need
   * a column recording the status before deletion, which is not worth carrying
   * for a combination nobody has asked for. Restoring from trash lands at READY
   * and can be archived again.
   */
  async archive(id: string, context: RequestContext): Promise<DocumentView> {
    const document = await this.mustFindActive(id);

    if (document.status === DocumentStatus.ARCHIVED) {
      throw new ConflictException(
        apiError(ERROR_CODES.DOCUMENT_ALREADY_ARCHIVED, 'That document is already archived'),
      );
    }

    /**
     * Refused mid-pipeline, and this is not a nicety.
     *
     * The processing run ends with an unconditional advance to READY, so a
     * document archived while a worker held it would quietly un-archive itself
     * when that worker finished — with nothing in the audit trail to explain it.
     */
    this.assertNotInFlight(document);

    const updated = await this.db.document.update({
      where: { id },
      data: { status: DocumentStatus.ARCHIVED },
      select: DOCUMENT_SUMMARY,
    });

    await this.audit.record({
      action: 'document.archive',
      entityType: 'Document',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: document.name },
    });

    return toView(updated);
  }

  async unarchive(id: string, context: RequestContext): Promise<DocumentView> {
    const document = await this.mustFindActive(id);

    if (document.status !== DocumentStatus.ARCHIVED) {
      throw new ConflictException(
        apiError(ERROR_CODES.DOCUMENT_NOT_ARCHIVED, 'That document is not archived'),
      );
    }

    const updated = await this.db.document.update({
      where: { id },
      data: { status: DocumentStatus.READY },
      select: DOCUMENT_SUMMARY,
    });

    await this.audit.record({
      action: 'document.unarchive',
      entityType: 'Document',
      entityId: id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: document.name },
    });

    return toView(updated);
  }

  /**
   * The half `addVersion` and `revertToVersion` share: append the version row
   * and repoint the document at it, in one transaction.
   *
   * The version is created as a NESTED write through `document.update` rather
   * than as `documentVersion.create`. DocumentVersion is only transitively
   * scoped, so the guard waves a direct write through unfiltered; going through
   * the parent means the tenant filter on `document.update` covers both.
   */
  private async replaceCurrentBytes(
    id: string,
    input: {
      storageKey: string;
      size: bigint;
      hash: string | null;
      mimeType: string;
      extension: string;
      originalName: string;
      note?: string;
      userId: string;
      audit: { action: string; context: RequestContext; extra: Record<string, unknown> };
    },
  ): Promise<DocumentRow> {
    return this.db.$transaction(async (tx) => {
      const parent = await tx.document.findFirst({
        where: { id },
        select: {
          versions: {
            select: { versionNumber: true },
            orderBy: { versionNumber: 'desc' },
            take: 1,
          },
        },
      });

      /**
       * Read inside the transaction, but the real guarantee is the
       * `@@unique([documentId, versionNumber])` behind it: two uploads racing
       * at READ COMMITTED can both compute the same next number, and the loser
       * fails with P2002, which PrismaExceptionFilter turns into a 409. That is
       * the correct answer — one of the two uploads genuinely did not happen.
       */
      const versionNumber = (parent?.versions[0]?.versionNumber ?? 0) + 1;

      const updated = await tx.document.update({
        where: { id },
        data: {
          storageKey: input.storageKey,
          size: input.size,
          hash: input.hash,
          mimeType: input.mimeType,
          extension: input.extension,
          originalName: input.originalName,
          status: DocumentStatus.PROCESSING,
          versions: {
            create: {
              versionNumber,
              storageKey: input.storageKey,
              size: input.size,
              hash: input.hash,
              mimeType: input.mimeType,
              originalName: input.originalName,
              note: input.note ?? null,
              uploadedById: input.userId,
            },
          },
          /**
           * Reset both steps: the bytes changed, so the previous run's summary
           * and extracted text describe a file that is no longer being served.
           */
          metadata: {
            upsert: {
              create: { ocrStatus: 'QUEUED', aiStatus: 'PENDING' },
              update: { ocrStatus: 'QUEUED', ocrError: null, aiStatus: 'PENDING', aiError: null },
            },
          },
        },
        select: DOCUMENT_SUMMARY,
      });

      await this.audit.record(
        {
          action: input.audit.action,
          entityType: 'Document',
          entityId: id,
          ipAddress: input.audit.context.ipAddress,
          userAgent: input.audit.context.userAgent,
          metadata: { ...input.audit.extra, versionNumber },
        },
        tx,
      );

      return updated;
    });
  }

  /** Tells the owner someone else replaced their file. Never tells the actor. */
  private async announceNewVersion(
    ownerId: string,
    actorId: string,
    documentId: string,
    name: string,
  ): Promise<void> {
    if (ownerId === actorId) {
      return;
    }

    await this.notifications.create({
      userId: ownerId,
      type: NotificationType.DOCUMENT_VERSION_ADDED,
      actorId,
      entityType: 'Document',
      entityId: documentId,
      payload: { name, documentId },
    });
  }

  /**
   * Archive is read-only.
   *
   * Applied to every write that changes what the document IS — renaming,
   * re-filing, new versions, reverts, reprocessing. Deliberately NOT applied to
   * reading, downloading, commenting, or moving to the trash: freezing a record
   * is not the same as sealing it away, and an archived document that could not
   * be deleted would be a document nobody could ever get rid of.
   */
  private assertWritable(document: Pick<DocumentRow, 'status'>): void {
    if (document.status === DocumentStatus.ARCHIVED) {
      throw new ConflictException(
        apiError(
          ERROR_CODES.DOCUMENT_ARCHIVED,
          'That document is archived. Restore it before making changes.',
        ),
      );
    }
  }

  /**
   * Refuses while a worker is, or is about to be, writing to this document.
   * Two runs on one metadata row interleave, and the loser's partial results
   * overwrite the winner's complete ones.
   */
  private assertNotInFlight(document: Pick<DocumentRow, 'status'>): void {
    if (IN_FLIGHT.has(document.status)) {
      throw new ConflictException(
        apiError(
          ERROR_CODES.DOCUMENT_ALREADY_PROCESSING,
          'That document is already being processed',
        ),
      );
    }
  }

  private async mustFindActive(id: string): Promise<DocumentRow> {
    const document = await this.db.document.findFirst({
      where: { id, ...ACTIVE },
      select: DOCUMENT_SUMMARY,
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    return document;
  }

  /** Confirms the folder is in this tenant before a document is filed into it. */
  private async assertFolderExists(folderId: string): Promise<void> {
    const folder = await this.db.folder.findFirst({
      where: { id: folderId },
      select: { id: true },
    });

    if (!folder) {
      throw new NotFoundException(
        apiError(ERROR_CODES.FOLDER_NOT_FOUND, 'That folder does not exist'),
      );
    }
  }

  /**
   * An allowlist, not a blocklist.
   *
   * The multer limit already rejects oversized bodies, but the size is checked
   * again here because the limit and MAX_FILE_SIZE are configured in two
   * different places and only one of them is validated at boot.
   */
  private assertAcceptable(file: UploadedFile): void {
    if (!this.allowedMimeTypes.has(file.mimetype.toLowerCase())) {
      throw new BadRequestException(
        apiError(ERROR_CODES.MIME_NOT_ALLOWED, `Files of type ${file.mimetype} are not accepted`),
      );
    }

    if (file.size > this.maxFileSize) {
      throw new BadRequestException(
        apiError(
          ERROR_CODES.FILE_TOO_LARGE,
          `Files must be ${Math.floor(this.maxFileSize / 1024 / 1024)} MB or smaller`,
        ),
      );
    }
  }
}

/**
 * SHA-256 of the stored bytes.
 *
 * Streamed rather than read into memory: MAX_FILE_SIZE defaults to 100 MB, and
 * buffering that per concurrent upload is how an API runs out of heap.
 */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }

  return hash.digest('hex');
}

function toView<T extends { size: bigint }>(row: T): Omit<T, 'size'> & { size: string } {
  return { ...row, size: row.size.toString() };
}

/**
 * Collapses the nested favourite row into a flag and drops it from the payload.
 *
 * The client wants `isFavorite: true`, not `favorites: [{ userId: '…' }]` — and
 * shipping the raw rows would put the reader's own id in every list response for
 * no reason.
 */
function toFavoriteView<T extends { size: bigint; favorites: unknown[] }>(row: T) {
  const { favorites, ...rest } = row;

  return { ...rest, size: rest.size.toString(), isFavorite: favorites.length > 0 };
}

/**
 * Flattens the tag join rows into the labels themselves.
 *
 * Sorted by name, and shared with `findOne` rather than written twice, because
 * the join has no ordering of its own: two surfaces sorting differently would
 * show one document's chips in one order in the list and another on the detail
 * page, which reads as a change that never happened.
 */
function flattenTags(links: { tag: TagRef }[]): TagRef[] {
  return links.map((link) => link.tag).sort((a, b) => a.name.localeCompare(b.name));
}

/** The list row, with both join shapes collapsed to what the browser draws. */
function toRowView<T extends { size: bigint; favorites: unknown[]; tags: { tag: TagRef }[] }>(
  row: T,
) {
  const { tags, ...rest } = toFavoriteView(row);

  return { ...rest, tags: flattenTags(tags) };
}
