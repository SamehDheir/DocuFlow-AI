import { apiGet, apiSend, query } from './api';

/**
 * The in-app inbox.
 *
 * No endpoint here takes a user id. The API reads the recipient from the
 * verified token, so a client cannot ask for anyone else's mail.
 */

export type NotificationType =
  | 'DOCUMENT_READY'
  | 'DOCUMENT_FAILED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_APPROVED'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_CANCELLED'
  /** v4. Both are addressed to people with a stake in the document, never to the actor. */
  | 'DOCUMENT_COMMENTED'
  | 'DOCUMENT_VERSION_ADDED';

export interface AppNotification {
  id: string;
  type: NotificationType;
  entityType: string | null;
  entityId: string | null;
  /**
   * Interpolation values for the translated sentence — never a rendered
   * message. The server stores no prose, so switching language re-renders the
   * whole history rather than leaving old notifications in the old language.
   */
  payload: {
    name?: string;
    documentId?: string;
    reason?: string;
    note?: string;
    /** v4, on DOCUMENT_COMMENTED. Present so a link can land on the remark itself. */
    commentId?: string;
  } | null;
  /** Null means unread. */
  readAt: string | null;
  createdAt: string;
  actor: { id: string; firstName: string; lastName: string } | null;
}

export interface NotificationPage {
  items: AppNotification[];
  nextCursor: string | null;
  unread: number;
}

export function listNotifications(
  token: string,
  options: { cursor?: string; limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationPage> {
  return apiGet<NotificationPage>(
    `/notifications${query({
      cursor: options.cursor,
      limit: options.limit,
      unreadOnly: options.unreadOnly ? 'true' : undefined,
    })}`,
    token,
  );
}

/** Cheaper than a page fetch — used to reconcile the badge after a reconnect. */
export function unreadCount(token: string): Promise<{ unread: number }> {
  return apiGet<{ unread: number }>('/notifications/unread-count', token);
}

export function markNotificationRead(token: string, id: string): Promise<{ unread: number }> {
  return apiSend<{ unread: number }>('POST', `/notifications/${id}/read`, token);
}

export function markAllNotificationsRead(token: string): Promise<{ unread: number }> {
  return apiSend<{ unread: number }>('POST', '/notifications/read-all', token);
}
