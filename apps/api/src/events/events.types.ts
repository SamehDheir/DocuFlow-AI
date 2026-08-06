import type { DocumentStatus, ProcessingStage } from '@prisma/client';

/**
 * What the server pushes down the SSE stream.
 *
 * A discriminated union so the web can switch on `type` exhaustively. Payloads
 * stay small: an event says what changed, and the client refetches if it needs
 * detail. Shipping whole entities down a broadcast channel would mean deciding
 * per-field what each recipient is allowed to see, and the REST endpoints
 * already answer that question with a permission check behind them.
 */
export type LiveEvent =
  | {
      type: 'document.status';
      documentId: string;
      status: DocumentStatus;
      ocrStatus: ProcessingStage;
      aiStatus: ProcessingStage;
    }
  | {
      type: 'notification';
      /** Unread count after this arrived, so the badge needs no extra request. */
      unread: number;
    }
  | { type: 'approval.changed'; documentId: string; approvalId: string }
  /** Keeps proxies from closing an idle connection. The client ignores it. */
  | { type: 'ping' };

/**
 * An event on its way through Redis.
 *
 * `companyId` is the channel, and `userId` narrows delivery to one person —
 * a notification is addressed, a document status change is not.
 */
export interface PublishedEvent {
  companyId: string;
  /** Undefined means everyone in the company. */
  userId?: string;
  event: LiveEvent;
}

/** One channel per tenant, so a subscriber never sees another company's traffic. */
export function channelFor(companyId: string): string {
  return `docuflow:events:${companyId}`;
}
