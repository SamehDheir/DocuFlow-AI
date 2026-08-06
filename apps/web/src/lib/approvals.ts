import { apiGet, apiSend, query } from './api';

/**
 * Single-step document sign-off.
 *
 * Requesting rides on `documents.update`; deciding needs `documents.approve`,
 * which the Member role does not hold. The API enforces both, plus the rule
 * that nobody decides their own request.
 */

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface ApprovalPerson {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ApprovalRequest {
  id: string;
  status: ApprovalStatus;
  /** The requester's reason. */
  note: string | null;
  /** The decider's reason. Kept apart so a rejection never overwrites the ask. */
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  document: { id: string; name: string; mimeType: string; extension: string };
  requestedBy: ApprovalPerson;
  /** Null means open to anyone who can approve, not unassigned-and-stuck. */
  assignee: ApprovalPerson | null;
  decidedBy: ApprovalPerson | null;
}

export interface ApprovalPage {
  items: ApprovalRequest[];
  nextCursor: string | null;
}

/** `me` = waiting on me · `mine` = raised by me. */
export type ApprovalScope = 'me' | 'mine';

export function listApprovals(
  token: string,
  options: { status?: ApprovalStatus; scope?: ApprovalScope; cursor?: string } = {},
): Promise<ApprovalPage> {
  return apiGet<ApprovalPage>(
    `/approvals${query({ status: options.status, scope: options.scope, cursor: options.cursor })}`,
    token,
  );
}

export function documentApprovals(token: string, documentId: string): Promise<ApprovalRequest[]> {
  return apiGet<ApprovalRequest[]>(`/documents/${documentId}/approval`, token);
}

export function requestApproval(
  token: string,
  documentId: string,
  body: { assigneeId?: string; note?: string } = {},
): Promise<ApprovalRequest> {
  return apiSend<ApprovalRequest>('POST', `/documents/${documentId}/approval`, token, body);
}

export function decideApproval(
  token: string,
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  note?: string,
): Promise<ApprovalRequest> {
  return apiSend<ApprovalRequest>('POST', `/approvals/${id}/decision`, token, { decision, note });
}

export function cancelApproval(token: string, id: string): Promise<ApprovalRequest> {
  return apiSend<ApprovalRequest>('POST', `/approvals/${id}/cancel`, token);
}

/** The one request still open, if any. At most one exists per document. */
export function openRequest(requests: ApprovalRequest[]): ApprovalRequest | null {
  return requests.find((request) => request.status === 'PENDING') ?? null;
}
