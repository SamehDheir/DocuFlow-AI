import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { AuditModule } from '../common/audit/audit.module';
import type { Env } from '../config/env.validation';
import { StorageModule } from '../storage/storage.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

/**
 * Where uploads land before they are streamed to MinIO.
 *
 * A dedicated directory rather than the bare temp root, so a stale file is
 * identifiable as ours and the whole directory can be swept.
 */
const UPLOAD_TEMP_DIR = join(tmpdir(), 'docuflow-uploads');

@Module({
  imports: [
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
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
