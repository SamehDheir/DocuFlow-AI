import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../common/audit/audit.module';
import type { Env } from '../config/env.validation';
import { StorageModule } from '../storage/storage.module';
import { BulkDocumentsController } from './bulk-documents.controller';
import { BulkDocumentsService } from './bulk-documents.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { PdfRasterService } from './extraction/pdf-raster.service';
import { TextExtractorService } from './extraction/text-extractor.service';
import { DocumentProcessingService } from './processing/document-processing.service';
import { DocumentProcessingWorker } from './processing/document-processing.worker';

/**
 * Where uploads land before they are streamed to MinIO.
 *
 * A dedicated directory rather than the bare temp root, so a stale file is
 * identifiable as ours and the whole directory can be swept.
 */
const UPLOAD_TEMP_DIR = join(tmpdir(), 'docuflow-uploads');

@Module({
  imports: [
    AiModule,
    AuditModule,
    StorageModule,
    /**
     * Buffered to disk, not to memory.
     *
     * MAX_FILE_SIZE defaults to 100 MB; holding that per concurrent upload is
     * how the API runs out of heap. Writing to disk first also means size and
     * SHA-256 are known before any row is created, which is what lets the
     * upload pipeline avoid writing a document row it might have to unwind.
     */
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });

        return {
          /**
           * Multipart field values — the filename above all — are UTF-8.
           *
           * multer defaults this to `latin1` and hands it straight to busboy,
           * so an Arabic filename arrives decoded byte-for-byte as Western
           * European text: `تقرير.pdf` becomes `ØªÙ‚Ø±ÙŠØ±.pdf`, and that
           * mojibake is what gets persisted as `originalName` and echoed back
           * in Content-Disposition on download. The product ships in Arabic, so
           * the default is simply wrong here.
           */
          defParamCharset: 'utf8',
          storage: diskStorage({
            destination: UPLOAD_TEMP_DIR,
            /**
             * The client's filename NEVER reaches the filesystem. It is
             * attacker-controlled text, and using it here is the textbook path
             * traversal — the original is kept in the database column instead.
             */
            filename: (_request, _file, callback) => callback(null, randomUUID()),
          }),
          limits: { fileSize: config.get('MAX_FILE_SIZE', { infer: true }), files: 1 },
        };
      },
    }),
  ],
  /**
   * ORDER MATTERS, and this is the only place it is expressed.
   *
   * Nest registers routes controller by controller, in this array's order.
   * BulkDocumentsController serves `documents/bulk/<action>`, and
   * DocumentsController declares two-segment `:id/...` patterns — `:id/restore`
   * and `:id/archive` among them — which would match `documents/bulk/restore`
   * with `:id` bound to "bulk" and fail in ParseUUIDPipe. Listing bulk first is
   * what stops that; `bulk.e2e-spec.ts` is what notices if it is undone.
   */
  controllers: [BulkDocumentsController, DocumentsController],
  /**
   * The processing worker lives here rather than in QueueModule: it needs the
   * pipeline below, and QueueModule is already imported for the producer, so
   * pairing them there would be a dependency cycle. QueueModule is @Global, so
   * QUEUE_CONNECTION and the producer resolve without an explicit import.
   */
  providers: [
    DocumentsService,
    BulkDocumentsService,
    PdfRasterService,
    TextExtractorService,
    DocumentProcessingService,
    DocumentProcessingWorker,
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
