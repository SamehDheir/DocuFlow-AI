import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * Builds an ioredis connection configured the way BullMQ requires.
 *
 * `maxRetriesPerRequest: null` is not optional and not a tuning choice. BullMQ
 * workers hold a blocking BRPOPLPUSH open for long stretches; with ioredis'
 * default retry ceiling that command is aborted mid-wait and the worker throws
 * on an idle queue. BullMQ refuses to start without this set.
 *
 * `enableReadyCheck: false` for the same family of reasons — the ready check
 * races with blocking commands on a reconnect.
 *
 * Each caller gets its OWN connection. A Redis client running a blocking
 * command cannot serve anything else, so sharing one between the queue, the
 * worker and the events subscriber would deadlock them against each other.
 */
export function createRedisConnection(url: string, label: string): Redis {
  const logger = new Logger(`Redis:${label}`);

  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    /**
     * Redis is pinned to `noeviction` (docker-compose.yml) precisely so queued
     * jobs are never dropped under memory pressure. Retrying the connection
     * indefinitely matches that intent: a queue that gives up on reconnecting
     * silently stops processing uploads.
     */
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  client.on('error', (error: Error) => {
    // Logged, not thrown. ioredis reconnects on its own, and an unhandled
    // 'error' event would take the process down over a transient blip.
    logger.error(`Redis connection error: ${error.message}`);
  });

  return client;
}
