import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.validation';
import { DocumentProcessingProducer } from './document-processing.producer';
import { QUEUE_CONNECTION } from './queue.constants';
import { createRedisConnection } from './redis.connection';

/**
 * Redis and the job queue.
 *
 * Global because two unrelated features need the same connection — the
 * processing queue and the SSE event bus — and threading an import through
 * every module that might one day publish an event is noise.
 *
 * This module deliberately does NOT own the worker. The worker needs the
 * document processing pipeline, which lives in DocumentsModule, and
 * DocumentsModule needs the producer from here — so putting both halves in one
 * module would be a circular dependency. The producer lives here, the consumer
 * lives beside the code it drives.
 */
@Global()
@Module({
  providers: [
    {
      provide: QUEUE_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Redis =>
        createRedisConnection(config.get('REDIS_URL', { infer: true }), 'queue'),
    },
    DocumentProcessingProducer,
  ],
  exports: [QUEUE_CONNECTION, DocumentProcessingProducer],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(QUEUE_CONNECTION) private readonly connection: Redis) {}

  /**
   * Closes the connection on shutdown so the process can actually exit — an
   * open ioredis socket keeps the event loop alive indefinitely, which turns a
   * clean stop into a hung container that the orchestrator eventually kills.
   *
   * Requires `app.enableShutdownHooks()` in main.ts to fire at all.
   */
  onApplicationShutdown(): void {
    this.connection.disconnect();
  }
}
