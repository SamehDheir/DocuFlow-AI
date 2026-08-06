import { Inject, Injectable, Logger } from '@nestjs/common';
import { DocumentStatus, NotificationType, ProcessingStage, type Prisma } from '@prisma/client';
import { AI_PROVIDER, type AiProvider } from '../../ai/ai-provider.interface';
import { AuditService } from '../../common/audit/audit.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { EventsService } from '../../events/events.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { TENANT_PRISMA } from '../../prisma/prisma.module';
import type { TenantGuardedClient } from '../../prisma/tenant-guard';
import type { DocumentProcessingJob } from '../../queue/queue.constants';
import { StorageService } from '../../storage/storage.service';
import { TextExtractorService, type ExtractionResult } from '../extraction/text-extractor.service';

/**
 * The v2 half of the upload pipeline.
 *
 * v1 went UPLOADING → READY in one transaction because there was nothing to do
 * in between. This is what fills that gap, and it runs on a queue worker rather
 * than in the request: OCR on a 20-page scan takes minutes, and a browser
 * holding an upload open that long is not a product.
 *
 *   PROCESSING → OCR → AI_ANALYSIS → READY
 *
 * FAILURE IS NOT TERMINAL FOR THE DOCUMENT. Whatever happens below, the file
 * was uploaded successfully and its bytes are in MinIO — it must stay
 * listable, previewable and downloadable. So the document still ends at READY,
 * and the failure is recorded on `ocrStatus` / `aiStatus` with a message. The
 * alternative — parking it in a failed state — would mean a summariser timeout
 * makes someone's contract disappear from their document list.
 *
 * TENANCY: every call here runs inside `TenantContextService.runAs()`, bound by
 * the worker from the job payload. There is no request and no JWT, so without
 * that the fail-closed guard rejects the first query. `runAsSystem()` would
 * also "work" and is the wrong tool: it would hand a job for one customer
 * access to every customer's rows.
 */
@Injectable()
export class DocumentProcessingService {
  private readonly logger = new Logger(DocumentProcessingService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly storage: StorageService,
    private readonly extractor: TextExtractorService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
    private readonly tenant: TenantContextService,
  ) {}

  /** Entry point for the worker. Binds the tenant, then runs the pipeline. */
  async process(job: DocumentProcessingJob): Promise<void> {
    await this.tenant.runAs(job.companyId, job.userId, () => this.run(job));
  }

  private async run(job: DocumentProcessingJob): Promise<void> {
    const document = await this.db.document.findFirst({
      where: { id: job.documentId, deletedAt: null },
      select: { id: true, name: true, mimeType: true, storageKey: true, ownerId: true },
    });

    if (!document) {
      // Deleted between enqueue and pickup. Not an error — just nothing to do.
      this.logger.warn(`Document ${job.documentId} no longer exists; skipping processing`);
      return;
    }

    await this.advance(job.companyId, document.id, DocumentStatus.PROCESSING, {
      ocrStatus: ProcessingStage.RUNNING,
    });

    let extraction: ExtractionResult | null = null;
    let ocrError: string | null = null;

    // --- Text extraction / OCR ----------------------------------------------
    try {
      await this.advance(job.companyId, document.id, DocumentStatus.OCR, {});

      const bytes = await this.storage.getBuffer(document.storageKey);
      extraction = await this.extractor.extract(bytes, document.mimeType);
    } catch (error) {
      ocrError = messageOf(error);
      this.logger.error(`Text extraction failed for document ${document.id}: ${ocrError}`);
    }

    const ocrStatus = ocrError
      ? ProcessingStage.FAILED
      : extraction && extraction.source !== 'none'
        ? ProcessingStage.DONE
        : // Nothing went wrong; there was simply no text to find.
          ProcessingStage.SKIPPED;

    await this.writeMetadata(document.id, {
      extractedText: extraction?.text || null,
      ocrStatus,
      ocrError,
      ocrPages: extraction?.pages ?? null,
      ocrCompletedAt: new Date(),
      // Only fill parser-provided metadata where the user has set nothing.
      ...(extraction?.title ? { title: extraction.title } : {}),
      ...(extraction?.author ? { author: extraction.author } : {}),
    });

    // --- AI analysis ---------------------------------------------------------
    const text = extraction?.text?.trim() ?? '';
    let aiStatus: ProcessingStage = ProcessingStage.SKIPPED;
    let aiError: string | null = null;

    if (text) {
      await this.advance(job.companyId, document.id, DocumentStatus.AI_ANALYSIS, {
        aiStatus: ProcessingStage.RUNNING,
      });

      try {
        const summary = await this.ai.summarise(text);

        await this.writeMetadata(document.id, {
          summary: summary.summary ?? null,
          // Keywords only when the AI found some — an empty array would wipe
          // whatever a user had curated by hand.
          ...(summary.keywords?.length ? { keywords: summary.keywords } : {}),
          ...(summary.language ? { language: summary.language } : {}),
          aiStatus: ProcessingStage.DONE,
          aiError: null,
          aiModel: this.ai.name,
          aiCompletedAt: new Date(),
        });

        aiStatus = ProcessingStage.DONE;
        await this.embed(document.id, text);
      } catch (error) {
        aiError = messageOf(error);
        aiStatus = ProcessingStage.FAILED;

        this.logger.error(`AI analysis failed for document ${document.id}: ${aiError}`);

        await this.writeMetadata(document.id, {
          aiStatus,
          aiError,
          aiCompletedAt: new Date(),
        });
      }
    } else {
      await this.writeMetadata(document.id, { aiStatus, aiCompletedAt: new Date() });
    }

    // --- Done ----------------------------------------------------------------
    await this.advance(job.companyId, document.id, DocumentStatus.READY, {});

    const failed = ocrStatus === ProcessingStage.FAILED || aiStatus === ProcessingStage.FAILED;

    await this.audit.record({
      action: job.reprocess ? 'document.reprocess' : 'document.process',
      entityType: 'Document',
      entityId: document.id,
      companyId: job.companyId,
      userId: job.userId,
      metadata: {
        name: document.name,
        source: extraction?.source ?? 'none',
        ocrStatus,
        aiStatus,
        ...(extraction?.truncated ? { truncated: true } : {}),
      },
    });

    /**
     * Told to the owner, not the person who triggered a reprocess: the owner is
     * who cares that their document is now searchable. Skipped when nothing
     * happened — a plain text file that needed no analysis is not news.
     */
    if (failed || extraction?.source === 'ocr' || aiStatus === ProcessingStage.DONE) {
      await this.notifications.create({
        userId: document.ownerId,
        type: failed ? NotificationType.DOCUMENT_FAILED : NotificationType.DOCUMENT_READY,
        entityType: 'Document',
        entityId: document.id,
        payload: { name: document.name, ...(failed ? { reason: ocrError ?? aiError } : {}) },
      });

      await this.events.publish({
        companyId: job.companyId,
        userId: document.ownerId,
        event: {
          type: 'notification',
          unread: await this.notifications.unreadCount(document.ownerId),
        },
      });
    }
  }

  /**
   * Moves the lifecycle on and tells every watching browser.
   *
   * Status changes are broadcast to the whole company rather than to one user
   * because anyone with the documents list open is looking at that row.
   */
  private async advance(
    companyId: string,
    documentId: string,
    status: DocumentStatus,
    metadata: Prisma.DocumentMetadataUpdateInput,
  ): Promise<void> {
    await this.db.document.update({
      where: { id: documentId },
      data: {
        status,
        ...(Object.keys(metadata).length
          ? {
              metadata: {
                upsert: {
                  create: metadata as Prisma.DocumentMetadataCreateWithoutDocumentInput,
                  update: metadata,
                },
              },
            }
          : {}),
      },
      select: { id: true },
    });

    const current = await this.db.document.findFirst({
      where: { id: documentId },
      select: { metadata: { select: { ocrStatus: true, aiStatus: true } } },
    });

    await this.events.publish({
      companyId,
      event: {
        type: 'document.status',
        documentId,
        status,
        ocrStatus: current?.metadata?.ocrStatus ?? ProcessingStage.PENDING,
        aiStatus: current?.metadata?.aiStatus ?? ProcessingStage.PENDING,
      },
    });
  }

  /**
   * Upserts through the document, never directly.
   *
   * DocumentMetadata carries no companyId, so the tenant guard passes a direct
   * `documentMetadata.upsert` through unfiltered — and refuses it outright for
   * exactly that reason. Nested through the scoped parent, the guard sees a
   * Document.update and scopes it normally.
   */
  private async writeMetadata(
    documentId: string,
    data: Prisma.DocumentMetadataUpdateInput,
  ): Promise<void> {
    await this.db.document.update({
      where: { id: documentId },
      data: {
        metadata: {
          upsert: {
            create: data as Prisma.DocumentMetadataCreateWithoutDocumentInput,
            update: data,
          },
        },
      },
      select: { id: true },
    });
  }

  /**
   * Writes the embedding, when there is a provider that produces one.
   *
   * Raw SQL because Prisma has no vector type — and therefore NOT covered by
   * the tenant guard, which only sees model operations. The company predicate
   * below is written by hand and read from the bound context, never from a
   * caller. See the LIMITATION note in tenant-guard.ts.
   *
   * Returns quietly when the provider has no embeddings endpoint, which is the
   * normal case on xAI. Search stays on full text and nothing else changes.
   */
  private async embed(documentId: string, text: string): Promise<void> {
    let vector: number[] | null = null;

    try {
      vector = await this.ai.embed(text);
    } catch (error) {
      // Never fails the document: ranking degrades, the summary is unaffected.
      this.logger.warn(`Embedding failed for document ${documentId}: ${messageOf(error)}`);
      return;
    }

    if (!vector?.length) {
      return;
    }

    const companyId = this.tenant.getCompanyId();

    if (!companyId) {
      this.logger.error('Refusing to write an embedding with no tenant bound');
      return;
    }

    await this.db.$executeRaw`
      UPDATE document_metadata dm
         SET embedding = ${`[${vector.join(',')}]`}::vector
        FROM documents d
       WHERE dm.document_id = d.id
         AND d.id = ${documentId}::uuid
         AND d.company_id = ${companyId}::uuid
    `;
  }
}

/** Keeps a thrown non-Error from becoming the string "[object Object]" in a column. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
