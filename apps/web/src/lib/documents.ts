import { API_URL, ApiError, apiGet, apiSend, query } from './api';

/** The API's own MAX_FILE_SIZE default, mirrored so the two ceilings agree. */
const DEFAULT_MAX_FILE_SIZE = 104857600;

/**
 * Upload ceiling, mirroring the API's MAX_FILE_SIZE.
 *
 * Falls back to the same 100 MB the server defaults to, so a missing env var
 * cannot silently raise the client's limit above the server's.
 *
 * Validated rather than trusted, because `??` alone is not enough here. This is
 * a NEXT_PUBLIC_* value inlined at build time from a Docker build arg, and an
 * arg passed but left empty — an unset repository variable in release.yml, say —
 * arrives as `''`, which is not nullish and which `Number('')` turns into 0.
 * That ceiling rejects every file, including a 1 KB one.
 */
const configured = Number(process.env.NEXT_PUBLIC_MAX_FILE_SIZE);
export const MAX_FILE_SIZE =
  Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_FILE_SIZE;

/**
 * Documents and folders client.
 *
 * Every call takes an access token explicitly and is meant to be wrapped in
 * `useSession().withToken(...)`, which renews once and replays on a 401.
 */

/**
 * Mirrors Prisma's DocumentStatus.
 *
 * v2 makes the middle of this range real: an upload now lands at PROCESSING and
 * walks OCR → AI_ANALYSIS → READY on a queue worker, pushed to the browser over
 * the live event stream rather than polled for.
 */
export type DocumentStatus =
  | 'CREATED'
  | 'UPLOADING'
  | 'UPLOADED'
  | 'PROCESSING'
  | 'OCR'
  | 'AI_ANALYSIS'
  | 'READY'
  | 'ARCHIVED'
  | 'DELETED';

/** Per-step outcome, tracked separately from the lifecycle. */
export type ProcessingStage = 'PENDING' | 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

/**
 * The lightweight processing state carried on every list row.
 *
 * Deliberately excludes `extractedText` and `summary` — a page of scanned
 * contracts would otherwise ship megabytes just to draw status badges. Those
 * arrive only on the detail request.
 */
export interface ProcessingState {
  ocrStatus: ProcessingStage;
  aiStatus: ProcessingStage;
  ocrPages: number | null;
}

/** True while a worker still has this document in hand. */
export const PROCESSING_STATUSES: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>([
  'UPLOADING',
  'PROCESSING',
  'OCR',
  'AI_ANALYSIS',
]);

export function isProcessing(status: DocumentStatus): boolean {
  return PROCESSING_STATUSES.has(status);
}

export interface DocumentSummary {
  id: string;
  name: string;
  originalName: string;
  mimeType: string;
  extension: string;
  /** A string, not a number: sizes are BigInt server-side and exceed 2^53. */
  size: string;
  status: DocumentStatus;
  folderId: string | null;
  ownerId: string;
  hash: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Absent on rows written before v2, and on the trash listing. */
  metadata?: ProcessingState | null;
  /**
   * The CALLER's own bookmark — two colleagues see different values here.
   *
   * Optional because `uploadDocument` and the single-document mutations return
   * the plain summary, which carries no star. Only the list projection resolves
   * it, so a row spread from a mutation response keeps whatever it already had
   * rather than silently reading as unstarred.
   */
  isFavorite?: boolean;
  /**
   * The labels on this row, present on the list projection only.
   *
   * Optional for the same reason as `isFavorite`: a row patched from a rename or
   * an archive response must not lose its chips.
   */
  tags?: DocumentTag[];
}

/** A label from the company-wide vocabulary. `color` is a token name, not a hex. */
export interface DocumentTag {
  id: string;
  name: string;
  color: string | null;
}

/**
 * One entry in a document's history.
 *
 * Carries its own `originalName` and `mimeType` rather than borrowing the
 * parent's, so a .docx that was later replaced by a .pdf still reads as what it
 * was — and so a revert can restore the type and the filename, not just bytes.
 */
export interface DocumentVersion {
  id: string;
  versionNumber: number;
  size: string;
  createdAt: string;
  originalName: string;
  mimeType: string;
  /** What changed, in the uploader's words. Nothing infers it. */
  note: string | null;
  uploadedById: string;
  uploadedBy: { id: string; firstName: string; lastName: string };
}

export interface DocumentDetail extends DocumentSummary {
  metadata:
    | (ProcessingState & {
        title: string | null;
        description: string | null;
        language: string | null;
        keywords: string[];
        summary: string | null;
        extractedText: string | null;
        ocrError: string | null;
        aiError: string | null;
        aiModel: string | null;
      })
    | null;
  owner: { id: string; firstName: string; lastName: string; email: string };
  folder: { id: string; name: string } | null;
  versions: DocumentVersion[];
  tags: DocumentTag[];
  /** The CALLER's own bookmark. Two colleagues see different values here. */
  isFavorite: boolean;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  /**
   * Files filed directly in this folder, excluding trashed ones and excluding
   * subfolders' contents — so it always matches what selecting the folder
   * lists.
   */
  documentCount: number;
}

export interface FolderDetail {
  folder: Folder;
  children: Folder[];
  breadcrumb: { id: string; name: string }[];
  documentCount: number;
}

export interface DocumentPage {
  items: DocumentSummary[];
  nextCursor: string | null;
}

export interface StorageStats {
  documents: number;
  storageBytes: string;
  trashed: number;
}

export interface ListOptions {
  folderId?: string;
  q?: string;
  status?: DocumentStatus;
  cursor?: string;
  limit?: number;
  trash?: boolean;
  /** Narrows to documents carrying this tag. */
  tagId?: string;
  /** Narrows to the caller's own starred documents. There is no way to ask for anyone else's. */
  favorite?: boolean;
  /**
   * Puts archived documents back in the results.
   *
   * They are hidden by default — a status that changed nothing about what you
   * see would not be worth setting.
   */
  includeArchived?: boolean;
}

export function listDocuments(token: string, options: ListOptions = {}): Promise<DocumentPage> {
  return apiGet<DocumentPage>(
    `/documents${query({
      // An empty string is meaningful — it means "the root" — so it must not be
      // dropped the way `undefined` is.
      folderId: options.folderId,
      q: options.q || undefined,
      status: options.status,
      cursor: options.cursor,
      limit: options.limit,
      trash: options.trash ? 'true' : undefined,
      tagId: options.tagId,
      // `undefined` rather than 'false', so an unset filter leaves the parameter
      // off entirely. The API reads these as `=== 'true'`, so 'false' would work
      // — but it would also put a filter in the URL that is not filtering.
      favorite: options.favorite ? 'true' : undefined,
      includeArchived: options.includeArchived ? 'true' : undefined,
    })}`,
    token,
  );
}

export function getDocument(token: string, id: string): Promise<DocumentDetail> {
  return apiGet<DocumentDetail>(`/documents/${id}`, token);
}

export function getStats(token: string): Promise<StorageStats> {
  return apiGet<StorageStats>('/documents/stats', token);
}

export function renameDocument(token: string, id: string, name: string): Promise<DocumentSummary> {
  return apiSend<DocumentSummary>('PATCH', `/documents/${id}`, token, { name });
}

export function moveDocument(
  token: string,
  id: string,
  folderId: string | null,
): Promise<DocumentSummary> {
  return apiSend<DocumentSummary>('PATCH', `/documents/${id}`, token, { folderId });
}

export function deleteDocument(token: string, id: string): Promise<DocumentSummary> {
  return apiSend<DocumentSummary>('DELETE', `/documents/${id}`, token);
}

export function restoreDocument(token: string, id: string): Promise<DocumentSummary> {
  return apiSend<DocumentSummary>('POST', `/documents/${id}/restore`, token);
}

/**
 * Re-runs text extraction and AI analysis.
 *
 * Also the backfill path for documents uploaded before v2, whose metadata sits
 * at PENDING with no extracted text. Returns the document at PROCESSING; the
 * rest arrives over the live event stream.
 */
export function reprocessDocument(token: string, id: string): Promise<DocumentSummary> {
  return apiSend<DocumentSummary>('POST', `/documents/${id}/reprocess`, token);
}

/**
 * Freezes a document, or thaws it.
 *
 * Archive is a status, not a place: the row stays where it is and stays
 * downloadable. It only leaves the default listing, which is the whole point of
 * setting it — and the API refuses renames, moves and new versions while it
 * holds, though comments and deletion still work.
 */
export function archiveDocument(token: string, id: string): Promise<DocumentSummary> {
  return apiSend<DocumentSummary>('POST', `/documents/${id}/archive`, token);
}

export function unarchiveDocument(token: string, id: string): Promise<DocumentSummary> {
  return apiSend<DocumentSummary>('POST', `/documents/${id}/unarchive`, token);
}

/**
 * Stars a document, or unstars it.
 *
 * Both halves are idempotent server-side — starring twice is not an error, and
 * neither is unstarring something that was never starred — which is what lets
 * the UI flip the icon first and reconcile afterwards. There is no audit row
 * behind either: a favourite changes nothing about the document, and writing one
 * would publish a private shortlist to everyone holding `audit.read`.
 *
 * The star is always the CALLER's. No endpoint anywhere accepts a user id
 * beside it, because colleagues share a company and "show me their favourites"
 * is a within-tenant leak the tenant guard cannot see.
 */
export function setFavorite(token: string, id: string, favorite: boolean): Promise<void> {
  return apiSend<void>(favorite ? 'POST' : 'DELETE', `/documents/${id}/favorite`, token);
}

/** Why one id in a batch was refused. A code, so the web can translate it. */
export interface BulkSkip {
  id: string;
  code: string;
}

/**
 * What a bulk action did, per id.
 *
 * PARTIAL SUCCESS IS THE CONTRACT, not a fallback, and the response is 200 even
 * when nothing succeeded. A multi-select runs over a paginated list, so some
 * rows are always stale by the time the button is pressed — a colleague archived
 * one, a worker picked another up. All-or-nothing would mean never completing
 * the action without first hunting for whichever id went bad.
 *
 * `requested` is the DEDUPED count, so it can be smaller than the array sent.
 */
export interface BulkResult {
  requested: number;
  succeeded: string[];
  skipped: BulkSkip[];
}

/**
 * The API's cap on one batch, mirrored so the UI can stop before the 400.
 *
 * 200 against a page size of 100 means "select all on this page" fits twice
 * over. A selection larger than this needs the client to send more than one
 * request, which nothing in the UI does yet — see NEXT_STEPS.md.
 */
export const MAX_BULK_IDS = 200;

/** One route per action, because the permission genuinely differs per action. */
const bulk = (token: string, action: string, body: Record<string, unknown>): Promise<BulkResult> =>
  apiSend<BulkResult>('POST', `/documents/bulk/${action}`, token, body);

export function bulkDelete(token: string, ids: string[]): Promise<BulkResult> {
  return bulk(token, 'delete', { ids });
}

export function bulkRestore(token: string, ids: string[]): Promise<BulkResult> {
  return bulk(token, 'restore', { ids });
}

export function bulkArchive(token: string, ids: string[]): Promise<BulkResult> {
  return bulk(token, 'archive', { ids });
}

export function bulkUnarchive(token: string, ids: string[]): Promise<BulkResult> {
  return bulk(token, 'unarchive', { ids });
}

/** `null` moves the selection to the company root. "Absent" is not a third state. */
export function bulkMove(
  token: string,
  ids: string[],
  folderId: string | null,
): Promise<BulkResult> {
  return bulk(token, 'move', { ids, folderId });
}

/**
 * Adds or removes tags across a selection — a DELTA, unlike the single-document
 * `setDocumentTags`, which replaces the whole set.
 *
 * Whole-set semantics across a multi-select would clear labels the caller never
 * saw, on rows they never opened: "tag these twenty Urgent" means they now also
 * carry Urgent, not that Urgent is all they carry. The single-document form can
 * afford replacement because it shows what is there first.
 *
 * Naming one tag on both sides is refused rather than resolved by picking an
 * order.
 */
export function bulkSetTags(
  token: string,
  ids: string[],
  change: { add?: string[]; remove?: string[] },
): Promise<BulkResult> {
  return bulk(token, 'tags', { ids, ...change });
}

/**
 * Appends a new file as the current version.
 *
 * Multipart rather than JSON, so it goes through `fetch` with a FormData body
 * instead of `apiSend`. No progress reporting here, unlike `uploadDocument`:
 * replacing a version is a deliberate, one-file act from a dialog that can show
 * a pending state, where the first upload is a drag-and-drop of many files at
 * once and needs a bar per file.
 */
export async function addVersion(
  token: string,
  id: string,
  file: File,
  note?: string,
): Promise<DocumentSummary> {
  const form = new FormData();
  form.append('file', file);

  if (note) {
    form.append('note', note);
  }

  const response = await fetch(`${API_URL}/api/documents/${id}/versions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
    body: form,
  });

  if (!response.ok) {
    throw await versionError(response);
  }

  return (await response.json()) as DocumentSummary;
}

/**
 * Puts an earlier version back at the top of the stack.
 *
 * Appends rather than rewinds — the old bytes are copied to a fresh key and a
 * new version row is written, so the history still shows that a revert happened
 * and the version reverted FROM is still there.
 */
export function revertToVersion(
  token: string,
  id: string,
  versionId: string,
  note?: string,
): Promise<DocumentSummary> {
  return apiSend<DocumentSummary>(
    'POST',
    `/documents/${id}/versions/${versionId}/revert`,
    token,
    note ? { note } : {},
  );
}

/**
 * Fetches an earlier version's bytes as an object URL.
 *
 * Download only — the API deliberately offers no inline preview of an old
 * version, because inline is a hardened surface and doubling it for a rare need
 * is not a trade worth making. Caller MUST revokeObjectURL.
 */
export async function fetchVersionBlob(
  token: string,
  id: string,
  versionId: string,
): Promise<string> {
  const response = await fetch(`${API_URL}/api/documents/${id}/versions/${versionId}/download`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
  });

  if (!response.ok) {
    throw new ApiError('That version could not be downloaded.', undefined, response.status);
  }

  return URL.createObjectURL(await response.blob());
}

/** Unwraps the API's error body from a raw fetch, as `apiFetch` does for JSON calls. */
async function versionError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      message?: string | string[];
      errors?: Record<string, string>;
      code?: string;
    };

    const message = Array.isArray(body.message) ? body.message[0] : body.message;

    return new ApiError(
      message ?? 'That version could not be uploaded.',
      body.errors,
      response.status,
      body.code,
    );
  } catch {
    return new ApiError('That version could not be uploaded.', undefined, response.status);
  }
}

export function listFolders(token: string): Promise<Folder[]> {
  return apiGet<Folder[]>('/folders', token);
}

export function getFolder(token: string, id: string): Promise<FolderDetail> {
  return apiGet<FolderDetail>(`/folders/${id}`, token);
}

export function createFolder(
  token: string,
  input: { name: string; parentId?: string },
): Promise<Folder> {
  return apiSend<Folder>('POST', '/folders', token, input);
}

export function renameFolder(token: string, id: string, name: string): Promise<Folder> {
  return apiSend<Folder>('PATCH', `/folders/${id}`, token, { name });
}

export function deleteFolder(token: string, id: string): Promise<void> {
  return apiSend<void>('DELETE', `/folders/${id}`, token);
}

/**
 * Fetches a document's bytes as an object URL.
 *
 * Downloads go through fetch rather than a plain link because the route needs
 * an Authorization header — the API deliberately does not issue presigned
 * storage URLs, since a URL cannot be re-checked once handed out.
 *
 * The caller MUST revokeObjectURL when finished, or the blob is pinned in
 * memory for the life of the document.
 */
export async function fetchDocumentBlob(
  token: string,
  id: string,
  inline = false,
): Promise<string> {
  const response = await fetch(
    `${API_URL}/api/documents/${id}/${inline ? 'preview' : 'download'}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    },
  );

  if (!response.ok) {
    throw new ApiError('That file could not be downloaded.', undefined, response.status);
  }

  const blob = await response.blob();

  /**
   * An inline preview is re-typed from OUR allowlist, never from the response.
   *
   * A blob: URL renders according to the blob's MIME type, and the response's
   * type traces back to `documents.mime_type`, which the uploading client
   * supplied. Left alone, a file that is really HTML but was declared as
   * application/pdf would be rendered as HTML inside our own origin by the
   * preview iframe — script execution against a real session.
   *
   * Re-wrapping with a type this module chose makes that impossible: HTML bytes
   * labelled application/pdf reach the PDF viewer and simply fail to parse.
   * Downloads skip this — they are never rendered, and the original type is
   * what the file should be saved as.
   */
  if (inline) {
    const declared = blob.type.toLowerCase();
    const safe = PREVIEWABLE.has(declared) ? declared : 'application/octet-stream';

    return URL.createObjectURL(new Blob([blob], { type: safe }));
  }

  return URL.createObjectURL(blob);
}

export interface UploadHandle {
  /** Resolves with the created document, rejects with an ApiError. */
  done: Promise<DocumentSummary>;
  /** Aborts the transfer. The promise then rejects with a cancelled ApiError. */
  cancel: () => void;
}

/**
 * Uploads one file, reporting progress.
 *
 * XMLHttpRequest, not fetch: no shipping browser reports UPLOAD progress
 * through fetch — `ReadableStream` request bodies are still not available for
 * this — and a 100 MB upload with no progress bar reads as a hung page. This is
 * the only place in the app that reaches for XHR, and it is why.
 */
export function uploadDocument(
  token: string,
  file: File,
  options: { folderId?: string; onProgress?: (percent: number) => void } = {},
): UploadHandle {
  const request = new XMLHttpRequest();

  const done = new Promise<DocumentSummary>((resolve, reject) => {
    /**
     * Size is checked HERE, before a single byte goes out.
     *
     * The server also enforces it, and must — but it can only do so by aborting
     * a transfer already in flight, and a browser meeting that abort reports
     * `net::ERR_CONNECTION_RESET` instead of the 413 the API actually sent. The
     * reader is told the server hung up, not that their file is too big. So the
     * limit is mirrored to the client purely so the common case fails in
     * language, instantly, without pushing 100 MB up the wire first.
     *
     * The MIME allowlist is deliberately NOT mirrored: an unaccepted type is
     * rejected only after the body has been read, so that 400 arrives intact
     * and renders correctly already. Duplicating the list here would buy
     * nothing and drift from the server's copy.
     */
    if (file.size > MAX_FILE_SIZE) {
      reject(
        new ApiError(
          'That file is larger than the upload limit.',
          undefined,
          413,
          'FILE_TOO_LARGE',
        ),
      );
      return;
    }

    const form = new FormData();
    form.append('file', file);

    if (options.folderId) {
      form.append('folderId', options.folderId);
    }

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        options.onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(JSON.parse(request.responseText) as DocumentSummary);
        return;
      }

      reject(parseXhrError(request));
    });

    request.addEventListener('error', () =>
      reject(new ApiError('Cannot reach the server. Check that the API is running.')),
    );
    request.addEventListener('abort', () =>
      reject(new ApiError('Upload cancelled.', undefined, undefined, 'UPLOAD_CANCELLED')),
    );

    request.open('POST', `${API_URL}/api/documents`);
    request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.withCredentials = true;
    request.send(form);
  });

  return { done, cancel: () => request.abort() };
}

function parseXhrError(request: XMLHttpRequest): ApiError {
  try {
    const body = JSON.parse(request.responseText) as {
      message?: string | string[];
      errors?: Record<string, string>;
      code?: string;
    };

    const message = Array.isArray(body.message) ? body.message[0] : body.message;

    return new ApiError(
      message ?? 'That file could not be uploaded.',
      body.errors,
      request.status,
      body.code,
    );
  } catch {
    return new ApiError('That file could not be uploaded.', undefined, request.status);
  }
}

/**
 * Types the API will stream inline, mirroring INLINE_PREVIEWABLE in
 * documents.service.ts.
 *
 * Mirrored so the UI never requests bytes it cannot render — the server stays
 * authoritative and still returns PREVIEW_NOT_AVAILABLE if this list ever
 * drifts ahead of it.
 *
 * A .docx is absent on purpose: no browser renders one. That is not a dead end
 * any more, though — the preview falls back to the text v2 extracted from it.
 */
const PREVIEWABLE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

export function isPreviewable(mimeType: string): boolean {
  return PREVIEWABLE.has(mimeType.toLowerCase());
}

/** Human-readable size, from the string the API returns. */
export function formatBytes(bytes: string | number, locale: string): string {
  const value = typeof bytes === 'string' ? Number(bytes) : bytes;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];

  let size = value;
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(size);

  return `${formatted} ${units[unit]}`;
}
