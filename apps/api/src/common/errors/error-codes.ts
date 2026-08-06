/**
 * Stable, machine-readable error codes.
 *
 * The web app ships in Arabic and English, but an API message is written once,
 * in English. Returning a code alongside it lets the client map the failure to
 * a translated string while `message` stays as the fallback for anything the
 * dictionary has not covered yet — see NEXT_STEPS.md §2, which records
 * untranslated API errors as the open item this closes.
 *
 * Codes are part of the contract: rename one and a translated message silently
 * falls back to English. Add rather than rename.
 */
export const ERROR_CODES = {
  // Authorisation
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  // Folders
  FOLDER_NOT_FOUND: 'FOLDER_NOT_FOUND',
  FOLDER_NAME_TAKEN: 'FOLDER_NAME_TAKEN',
  FOLDER_NOT_EMPTY: 'FOLDER_NOT_EMPTY',
  FOLDER_CYCLE: 'FOLDER_CYCLE',
  FOLDER_DEPTH_EXCEEDED: 'FOLDER_DEPTH_EXCEEDED',

  // Documents
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  DOCUMENT_NOT_DELETED: 'DOCUMENT_NOT_DELETED',
  FILE_REQUIRED: 'FILE_REQUIRED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  MIME_NOT_ALLOWED: 'MIME_NOT_ALLOWED',
  PREVIEW_NOT_AVAILABLE: 'PREVIEW_NOT_AVAILABLE',

  // Storage
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',

  // Processing — OCR and AI analysis
  /** Reprocess was asked for on a document already in the queue. */
  DOCUMENT_ALREADY_PROCESSING: 'DOCUMENT_ALREADY_PROCESSING',
  /** The queue is unreachable, so the work cannot be accepted rather than silently dropped. */
  PROCESSING_UNAVAILABLE: 'PROCESSING_UNAVAILABLE',

  // Search
  SEARCH_QUERY_REQUIRED: 'SEARCH_QUERY_REQUIRED',

  // Notifications
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',

  // Approvals
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  /** One open request per document — enforced by a partial unique index. */
  APPROVAL_ALREADY_PENDING: 'APPROVAL_ALREADY_PENDING',
  /** Approving, rejecting or cancelling something already decided. */
  APPROVAL_ALREADY_DECIDED: 'APPROVAL_ALREADY_DECIDED',
  /** Deciding your own request. */
  APPROVAL_SELF_DECISION: 'APPROVAL_SELF_DECISION',
  /** The request names a different assignee. */
  APPROVAL_NOT_ASSIGNEE: 'APPROVAL_NOT_ASSIGNEE',

  // Generic fallbacks, used by the Prisma filter when nothing more specific fits
  CONFLICT: 'CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * The body every deliberate failure returns.
 *
 * `errors` keeps the existing field-level shape that the web's `parseError()`
 * already understands, so adding `code` is additive rather than a break.
 */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  errors?: Record<string, string>;
}

export function apiError(
  code: ErrorCode,
  message: string,
  errors?: Record<string, string>,
): ApiErrorBody {
  return errors ? { code, message, errors } : { code, message };
}
