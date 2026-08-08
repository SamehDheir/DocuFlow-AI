import { apiGet, apiSend, query } from './api';

/**
 * The discussion attached to a document.
 *
 * Every call takes an access token explicitly, to be wrapped in
 * `useSession().withToken(...)`.
 *
 * Reading and posting hang off `/documents/:id/comments`; editing and deleting
 * name the comment itself, because there is nothing the document id would add to
 * `/comments/:id` beyond a second thing the handler could be made to trust.
 */

export interface CommentAuthor {
  id: string;
  firstName: string;
  lastName: string;
}

export interface Comment {
  id: string;
  documentId: string;
  body: string;
  /** Set when the body was rewritten, so the thread can mark it. Null otherwise. */
  editedAt: string | null;
  createdAt: string;
  author: CommentAuthor;
}

export interface CommentPage {
  items: Comment[];
  nextCursor: string | null;
  /**
   * How many comments the thread has in total, excluding deleted ones.
   *
   * Counted server-side against the same predicate the list uses, so a "3
   * comments" badge and the thread underneath it cannot disagree.
   */
  total: number;
}

/** Mirrors the API's `COMMENT_BODY_MAX`, so the counter and the 400 agree. */
export const COMMENT_BODY_MAX = 4000;

/**
 * A document's thread, oldest first.
 *
 * Oldest-first because a discussion is read from the top — the opposite of the
 * notification inbox, where only the newest matters.
 */
export function listComments(
  token: string,
  documentId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<CommentPage> {
  return apiGet<CommentPage>(
    `/documents/${documentId}/comments${query({ cursor: options.cursor, limit: options.limit })}`,
    token,
  );
}

export function createComment(token: string, documentId: string, body: string): Promise<Comment> {
  return apiSend<Comment>('POST', `/documents/${documentId}/comments`, token, { body });
}

/**
 * Rewrites a comment. Author-only, enforced by the API.
 *
 * Not even a moderator can edit — `comments.moderate` is "delete anyone's
 * comment", and putting different words in someone's mouth is not moderation.
 * A real change sets `editedAt`; re-sending identical text does not.
 */
export function updateComment(token: string, id: string, body: string): Promise<Comment> {
  return apiSend<Comment>('PATCH', `/comments/${id}`, token, { body });
}

/** Soft-deletes a comment. The author's own, or anyone's with `comments.moderate`. */
export function deleteComment(token: string, id: string): Promise<{ id: string }> {
  return apiSend<{ id: string }>('DELETE', `/comments/${id}`, token);
}
