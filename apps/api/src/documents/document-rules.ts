import { DocumentStatus } from '@prisma/client';

/**
 * The eligibility rules a document write has to satisfy, in one place.
 *
 * These were private to DocumentsService until bulk operations arrived. A bulk
 * action cannot call the single-document methods — each one is a find, a
 * validate, an update and an audit write, and doing that 200 times in a request
 * is 800 round trips — so it re-implements the same decisions against a set. Two
 * copies of "may this be archived?" is exactly the kind of pair that drifts, so
 * neither service owns them.
 */

/**
 * Soft-delete predicate.
 *
 * `Document.deletedAt` is NOT filtered by the tenant guard — that extension
 * handles `companyId` and nothing else, deliberately, because it is the security
 * boundary and stacking a second concern into it would put every cross-tenant
 * guarantee behind a change to unrelated logic.
 *
 * So every read spells this out, and this is the spelling. The list endpoint's
 * spec asserts a deleted document never appears.
 */
export const ACTIVE = { deletedAt: null } as const;

/**
 * Statuses that mean a worker is, or is about to be, writing to this document.
 * Re-queueing one of these would let two runs interleave on the same metadata row.
 */
export const IN_FLIGHT: ReadonlySet<DocumentStatus> = new Set([
  DocumentStatus.PROCESSING,
  DocumentStatus.OCR,
  DocumentStatus.AI_ANALYSIS,
]);

export function isInFlight(status: DocumentStatus): boolean {
  return IN_FLIGHT.has(status);
}

export function isArchived(status: DocumentStatus): boolean {
  return status === DocumentStatus.ARCHIVED;
}
