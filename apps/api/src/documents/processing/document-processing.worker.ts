import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Env } from '../../config/env.validation';
import {
  DOCUMENT_PROCESSING_QUEUE,
  QUEUE_CONNECTION,
  type DocumentProcessingJob,
} from '../../queue/queue.constants';
import { createRedisConnection } from '../../queue/redis.connection';
import { DocumentProcessingService } from './document-processing.service';

/**
 * Runs the processing pipeline off the queue.
 *
 * Lives in DocumentsModule rather than QueueModule: the consumer belongs beside
 * the code it drives, and putting it in QueueModule — which DocumentsModule
 * already imports for the producer — would be a dependency cycle.
 *
 * It gets its OWN Redis connection. A BullMQ worker holds a blocking command
 * open while waiting for jobs, and a connection in that state cannot serve
 * anything else; sharing the producer's connection would stall every enqueue
 * behind an idle worker.
 *
 * The worker starts with the API process. That is the right shape for this
 * deployment — one image, one container, in docker-compose — and the split into
 * a separate worker process becomes worthwhile only when OCR volume justifies
 * scaling them independently. Nothing here assumes co-location: jobs carry
 * their own tenant, so moving this to its own entrypoint is a wiring change.
 */
@Injectable()
export class DocumentProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentProcessingWorker.name);
  private worker?: Worker<DocumentProcessingJob>;
  private connection?: Redis;

  constructor(
    private readonly processing: DocumentProcessingService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_CONNECTION) private readonly shared: Redis,
  ) {
    // `shared` is injected only to guarantee QueueModule has initialised before
    // this worker starts; the worker itself uses its own connection below.
    void this.shared;
  }

  onModuleInit(): void {
    if (!this.config.get('QUEUE_WORKER_ENABLED', { infer: true })) {
      // Jobs are still enqueued by the producer; nothing in this process picks
      // them up. See the env comment for why the e2e suite runs this way.
      this.logger.log('Document processing worker is disabled (QUEUE_WORKER_ENABLED=false)');
      return;
    }

    this.connection = createRedisConnection(
      this.config.get('REDIS_URL', { infer: true }),
      'worker',
    );

    this.worker = new Worker<DocumentProcessingJob>(
      DOCUMENT_PROCESSING_QUEUE,
      async (job) => {
        this.logger.log(
          `Processing document ${job.data.documentId} (attempt ${job.attemptsMade + 1})`,
        );
        await this.processing.process(job.data);
      },
      {
        connection: this.connection,
        /**
         * Low on purpose. Each concurrent job holds an entire file in memory
         * (up to MAX_FILE_SIZE) while it is parsed or rasterised, so this
         * multiplies directly into the process's peak heap.
         */
        concurrency: this.config.get('QUEUE_CONCURRENCY', { infer: true }),
      },
    );

    /**
     * A thrown job is retried per DOCUMENT_JOB_OPTIONS and only lands here once
     * the attempts are exhausted. The pipeline already records per-step failure
     * on the document itself, so this is a log line rather than a state change.
     */
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Processing permanently failed for document ${job?.data.documentId ?? 'unknown'}: ${error.message}`,
      );
    });

    this.worker.on('error', (error) => {
      // Worker-level (not job-level) problems: a lost connection, a bad payload.
      this.logger.error(`Processing worker error: ${error.message}`);
    });

    this.logger.log(
      `Document processing worker started (concurrency ${this.config.get('QUEUE_CONCURRENCY', { infer: true })})`,
    );
  }

  /**
   * Waits for in-flight jobs rather than killing them.
   *
   * A job cut off mid-run leaves a document stuck at OCR or AI_ANALYSIS with no
   * process intending to finish it. Closing gracefully lets the current
   * document reach READY; anything still queued is picked up after the restart.
   */
  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.connection?.disconnect();
  }
}
