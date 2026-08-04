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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentStatus, type Prisma } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { ERROR_CODES, apiError } from '../common/errors/error-codes';
import type { RequestContext } from '../common/http/request-context';
import type { Env } from '../config/env.validation';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { tenantCreate, type TenantGuardedClient } from '../prisma/tenant-guard';
import { StorageService } from '../storage/storage.service';
import { buildStorageKey, extensionOf } from '../storage/storage-key';
import { DEFAULT_PAGE_SIZE, type ListDocumentsDto } from './dto/list-documents.dto';
import type { UpdateDocumentDto } from './dto/update-document.dto';
import type { UploadDocumentDto } from './dto/upload-document.dto';

/**
 * Soft-delete predicate.
 *
 * `Document.deletedAt` is NOT filtered by the tenant guard — that extension
 * handles `companyId` and nothing else, deliberately, because it is the
 * security boundary and stacking a second concern into it would put every
 * cross-tenant guarantee behind a change to unrelated logic.
 *
 * So every read spells this out. The list endpoint's spec asserts a deleted
 * document never appears.
 */
const ACTIVE = { deletedAt: null } as const;

/** Types safe to render inline. Everything else downloads as an attachment. */
const INLINE_PREVIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif']);

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

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly maxFileSize: number;
  private readonly allowedMimeTypes: Set<string>;

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
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
   *   1. validate           — cheapest rejections first, before any write
   *   2. row at UPLOADING   — a visible, sweepable state, not a silent orphan
   *   3. bytes to MinIO
   *   4. row to READY + version #1 + audit
   *
   * A crash between 2 and 4 leaves the document at UPLOADING, which the UI can
   * show as a failed upload and an operator can reap. That is strictly better
   * than the alternative ordering, where a crash leaves an object in the bucket
   * that nothing in the database references.
   *
   * v1 goes straight from UPLOADING to READY: there is no OCR or AI yet, so
   * there is nothing for PROCESSING to describe. The enum keeps the states
   * anyway, and step 4 is the seam — that is where v2 hands off to a queue and
   * lets PROCESSING → OCR → AI_ANALYSIS run before anything reaches READY.
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

      const ready = await this.db.$transaction(async (tx) => {
        const updated = await tx.document.update({
          where: { id: created.id },
          data: { status: DocumentStatus.READY },
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

      return toView(ready);
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
  async list(dto: ListDocumentsDto): Promise<{ items: DocumentView[]; nextCursor: string | null }> {
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    const inTrash = dto.trash === 'true';

    const where: Prisma.DocumentWhereInput = {
      ...(inTrash ? { deletedAt: { not: null } } : ACTIVE),
      ...(dto.folderId === undefined
        ? {}
        : { folderId: dto.folderId === '' ? null : dto.folderId }),
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.mimeType ? { mimeType: dto.mimeType } : {}),
      ...(dto.ownerId ? { ownerId: dto.ownerId } : {}),
      ...(dto.q ? { name: { contains: dto.q, mode: 'insensitive' as const } } : {}),
    };

    // One extra row is fetched purely to answer "is there another page?"
    // without a second count query.
    const rows = await this.db.document.findMany({
      where,
      select: DOCUMENT_SUMMARY,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });

    const items = rows.slice(0, limit);

    return {
      items: items.map(toView),
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

  async findOne(id: string) {
    const document = await this.db.document.findFirst({
      where: { id },
      select: {
        ...DOCUMENT_SUMMARY,
        metadata: { select: { title: true, description: true, language: true, keywords: true } },
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
          },
          orderBy: { versionNumber: 'desc' },
        },
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        folder: { select: { id: true, name: true } },
      },
    });

    if (!document) {
      throw new NotFoundException(
        apiError(ERROR_CODES.DOCUMENT_NOT_FOUND, 'That document does not exist'),
      );
    }

    return {
      ...toView(document),
      metadata: document.metadata,
      owner: document.owner,
      folder: document.folder,
      versions: document.versions.map((version) => ({
        ...version,
        size: version.size.toString(),
      })),
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
