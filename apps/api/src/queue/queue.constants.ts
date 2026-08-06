/**
 * Queue names and job payloads.
 *
 * Kept in their own file because both the producer (a request handler) and the
 * consumer (a worker with no request behind it) depend on them, and neither
 * should import the other.
 */

export const DOCUMENT_PROCESSING_QUEUE = 'document-processing';

/** DI token for the shared ioredis connection. */
export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

/**
 * Everything the worker needs to do its job.
 *
 * `companyId` is the important field. A worker runs outside any request, so
 * there is no JWT and no bound tenant context — the fail-closed guard would
 * reject every query it made. The company therefore has to travel with the job
 * and is bound with `TenantContextService.runAs()` before any query runs.
 *
 * It is taken from the document row at enqueue time, on the server, never from
 * anything a client sent.
 */
export interface DocumentProcessingJob {
  documentId: string;
  companyId: string;
  /**
   * Who caused the work — the uploader, or whoever asked for a reprocess.
   * Used to attribute the audit entry and to address the completion
   * notification. Optional because a future scheduled sweep has no user.
   */
  userId?: string;
  /** True when re-running over a document that was already processed once. */
  reprocess?: boolean;
}

/**
 * Retry policy.
 *
 * Three attempts with exponential backoff: a vision API returning 429 or 503 is
 * ordinarily transient, and giving up on the first one would strand documents
 * for a reason that resolves itself in seconds. Beyond three it is not
 * transient, and retrying costs money per attempt.
 *
 * Completed jobs are kept briefly so a failure is still inspectable in Redis;
 * failed ones are kept longer, since those are the ones anyone looks at.
 */
export const DOCUMENT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 86400 },
};
