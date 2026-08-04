import { API_URL, ApiError, apiGet, apiSend, query } from './api';

/**
 * Upload ceiling, mirroring the API's MAX_FILE_SIZE.
 *
 * Falls back to the same 100 MB the server defaults to, so a missing env var
 * cannot silently raise the client's limit above the server's.
 */
export const MAX_FILE_SIZE = Number(process.env.NEXT_PUBLIC_MAX_FILE_SIZE ?? 104857600);

/**
 * Documents and folders client.
 *
 * Every call takes an access token explicitly and is meant to be wrapped in
 * `useSession().withToken(...)`, which renews once and replays on a 401.
 */

/** Mirrors Prisma's DocumentStatus. v1 only ever produces UPLOADING and READY. */
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
}

export interface DocumentDetail extends DocumentSummary {
  metadata: { title: string | null; description: string | null } | null;
  owner: { id: string; firstName: string; lastName: string; email: string };
  folder: { id: string; name: string } | null;
  versions: { id: string; versionNumber: number; size: string; createdAt: string }[];
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

  return URL.createObjectURL(await response.blob());
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
 * Mirrored so the UI can hide the preview action for a .docx rather than
 * offering one that always fails — the server stays authoritative and still
 * returns PREVIEW_NOT_AVAILABLE if this list ever drifts ahead of it.
 */
const PREVIEWABLE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif']);

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
