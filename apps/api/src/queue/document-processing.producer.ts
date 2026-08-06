import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  DOCUMENT_JOB_OPTIONS,
  DOCUMENT_PROCESSING_QUEUE,
  QUEUE_CONNECTION,
  type DocumentProcessingJob,
} from './queue.constants';

/**
 * Puts documents on the processing queue.
 *
 * ORDERING: enqueue AFTER the database transaction commits, never inside it.
 * Workers are fast and Redis is not transactional with Postgres — a job
 * enqueued mid-transaction can be picked up before the row it refers to is
 * visible, and the worker then fails to find a document that does exist. The
 * cost of the safe order is a crash window where a committed document is never
 * queued, which is recoverable (the row is visibly stuck at PROCESSING and can
 * be reprocessed); the cost of the unsafe order is a race that fails randomly
 * under load.
 */
@Injectable()
export class DocumentProcessingProducer implements OnModuleDestroy {
  private readonly logger = new Logger(DocumentProcessingProducer.name);
  private readonly queue: Queue<DocumentProcessingJob>;

  constructor(@Inject(QUEUE_CONNECTION) connection: Redis) {
    this.queue = new Queue<DocumentProcessingJob>(DOCUMENT_PROCESSING_QUEUE, { connection });
  }

  /**
   * Returns whether the job was accepted rather than throwing.
   *
   * An upload that succeeded must not be reported as failed because Redis was
   * briefly unreachable — the bytes are in MinIO and the row is committed. The
   * caller leaves the document at PROCESSING, which is both visible in the UI
   * and recoverable through the reprocess endpoint.
   */
  async enqueue(job: DocumentProcessingJob): Promise<boolean> {
    try {
      await this.queue.add(DOCUMENT_PROCESSING_QUEUE, job, {
        ...DOCUMENT_JOB_OPTIONS,
        /**
         * The document id doubles as the job id, so a double-submit — a
         * retried request, a user clicking reprocess twice — collapses into
         * one job instead of paying for the same OCR twice. BullMQ drops an
         * add() whose jobId already exists.
         */
        jobId: job.documentId,
      });

      return true;
    } catch (error) {
      this.logger.error(
        `Could not enqueue processing for document ${job.documentId}; it stays at PROCESSING and can be reprocessed`,
        error,
      );

      return false;
    }
  }

  /**
   * Clears a finished job's id so the document can be queued again.
   *
   * Necessary because `jobId` is the document id: BullMQ keeps completed jobs
   * for a while (see DOCUMENT_JOB_OPTIONS), and while one exists a second
   * add() with the same id is silently ignored — which would make the
   * reprocess endpoint appear to work and do nothing.
   */
  async forget(documentId: string): Promise<void> {
    try {
      await (await this.queue.getJob(documentId))?.remove();
    } catch (error) {
      this.logger.warn(`Could not clear the previous job for document ${documentId}`, error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
