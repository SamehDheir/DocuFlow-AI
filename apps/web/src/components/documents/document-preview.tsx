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

  useEffect(() => {
    if (!item) return;

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
  }, [item, withToken, errors, common.genericError]);

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
      {state.kind === 'loading' ? (
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

      {state.kind === 'ready' ? (
        image ? (
          // eslint-disable-next-line @next/next/no-img-element -- a blob: URL cannot go through next/image, which needs a resolvable source.
          <img
            src={state.url}
            alt={item.name}
            className="mx-auto max-h-[70dvh] w-auto rounded-lg object-contain"
          />
        ) : (
          /*
           * Sandboxed, and deliberately without allow-scripts: this renders
           * bytes another user of the same company uploaded, inside our own
           * origin. The API sets the same sandbox in a CSP header on the
           * route; this is the second half of that.
           */
          <iframe
            src={state.url}
            title={item.name}
            sandbox=""
            className="border-border h-[70dvh] w-full rounded-lg border"
          />
        )
      ) : null}
    </Dialog>
  );
}

/** Whether the preview action should be offered for this document at all. */
export function canPreview(item: DocumentSummary): boolean {
  return isPreviewable(item.mimeType);
}
