import type { Request } from 'express';

/**
 * Who made the request, for the audit trail.
 *
 * "Who changed or deleted this file" is a problem the product exists to solve
 * (PROJECT_DOCUMENTATION.md §2), and the answer is worth little without the
 * where — so every mutating endpoint carries this through to `audit_logs`.
 */
export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

export function contextOf(request: Request): RequestContext {
  return { ipAddress: request.ip, userAgent: request.get('user-agent') };
}
