'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { Dictionary } from '@/i18n/get-dictionary';
import { fetchDocumentBlob, isPreviewable, type DocumentSummary } from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';

type State =
  { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error'; message: string };

/**
 * Quick look at a document without leaving the list.
 *
 * The bytes come through the API rather than a storage URL, for the same reason
 * downloads do — the API issues no presigned URLs, so every read stays behind
 * the same permission check. That means the file arrives as a blob and is shown
 * from an object URL, which has to be revoked or it pins the whole file in
 * memory for the life of the tab.
 */
export function DocumentPreview({
  item,
  onClose,
  t,
  errors,
  common,
  onDownload,
}: {
  /** null closes the dialog; a document opens it. */
  item: DocumentSummary | null;
  onClose: () => void;
  t: Dictionary['documents'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  onDownload: (item: DocumentSummary) => void;
}) {
  const { withToken } = useSession();

  /**
   * Starts as loading and is never reset, because the parent gives this
   * component a `key` per document — opening a different file mounts a fresh
   * instance rather than reusing this one. That keeps the effect from having to
   * setState synchronously to clear the previous file's bytes, which would be a
   * cascading render.
   */
  const [state, setState] = useState<State>({ kind: 'loading' });

  const renderable = item !== null && isPreviewable(item.mimeType);

  useEffect(() => {
    if (!item) return;

    /**
     * A type the API will not stream inline never gets fetched at all — the
     * request would only come back 400 PREVIEW_NOT_AVAILABLE. The dialog still
     * opens and says so, with the download beside it, because an action that
     * silently does nothing is worse than one that explains itself. That state
     * is derived from `renderable` at render time rather than stored, so
     * nothing has to be set here.
     */
    if (!renderable) return;

    let url: string | undefined;
    let current = true;

    void (async () => {
      try {
        const objectUrl = await withToken((token) => fetchDocumentBlob(token, item.id, true));

        // Closed while the bytes were in flight: revoke immediately, because
        // the cleanup below has already run and will not see this URL.
        if (!current) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        url = objectUrl;
        setState({ kind: 'ready', url: objectUrl });
      } catch (error) {
        if (current) {
          setState({ kind: 'error', message: errorMessage(error, errors, common.genericError) });
        }
      }
    })();

    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item, renderable, withToken, errors, common.genericError]);

  if (!item) return null;

  const image = item.mimeType.startsWith('image/');

  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      title={item.name}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.preview.close}
          </Button>
          <Button onClick={() => onDownload(item)}>{t.actions.download}</Button>
        </>
      }
    >
      {!renderable ? (
        <div className="border-border bg-surface-inset flex flex-col items-center rounded-lg border px-6 py-14 text-center">
          <span
            aria-hidden="true"
            className="border-border bg-surface text-text-subtle flex size-14 items-center justify-center rounded-xl border text-xs font-medium tracking-wide uppercase"
          >
            {item.extension.slice(0, 4)}
          </span>

          <p className="text-text-muted mt-5 max-w-sm text-sm text-balance">
            {errors.PREVIEW_NOT_AVAILABLE}
          </p>
        </div>
      ) : null}

      {renderable && state.kind === 'loading' ? (
        <div
          className="bg-surface-inset h-[60dvh] w-full animate-pulse rounded-lg"
          aria-busy="true"
          aria-live="polite"
        >
          <span className="sr-only">{t.preview.loading}</span>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div className="border-danger-border bg-danger-subtle rounded-lg border px-6 py-10 text-center">
          <p className="text-text-muted text-sm">{state.message}</p>
        </div>
      ) : null}

      {renderable && state.kind === 'ready' ? (
        image ? (
          // eslint-disable-next-line @next/next/no-img-element -- a blob: URL cannot go through next/image, which needs a resolvable source.
          <img
            src={state.url}
            alt={item.name}
            className="mx-auto max-h-[70dvh] w-auto rounded-lg object-contain"
          />
        ) : (
          /*
           * No `sandbox` attribute, which needs justifying.
           *
           * A sandboxed frame gets an opaque origin, and a blob: URL can only
           * be read by the origin that minted it — so `sandbox=""` meant the
           * frame could never load this at all. Chrome reports that as "This
           * page has been blocked by Chrome", which is what it did.
           *
           * What replaces it is control of the TYPE rather than the frame: the
           * blob is re-wrapped in fetchDocumentBlob with a MIME type taken from
           * our own allowlist, never from the response. That is the part that
           * matters, because `documents.mime_type` ultimately came from the
           * uploading client — bytes that are really HTML, stored as
           * application/pdf, would otherwise render as HTML in our origin.
           * Forced to application/pdf they go to the PDF viewer and fail to
           * parse, which is the correct outcome.
           */
          <iframe
            src={state.url}
            title={item.name}
            className="border-border h-[70dvh] w-full rounded-lg border"
          />
        )
      ) : null}
    </Dialog>
  );
}

/**
 * Whether the dialog will actually render this file's contents.
 *
 * NOT a gate on offering the action: the preview is offered for every document,
 * because a button that appears and disappears by file type reads as broken. A
 * type this returns false for opens the dialog on an explanatory state with the
 * download beside it.
 */
export function canPreview(item: DocumentSummary): boolean {
  return isPreviewable(item.mimeType);
}
