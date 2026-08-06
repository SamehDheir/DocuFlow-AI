'use client';

import { useEffect, useId, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { useLiveEvent } from '@/components/providers/live-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import {
  fetchDocumentBlob,
  getDocument,
  isPreviewable,
  type DocumentDetail,
  type DocumentSummary,
} from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';

type State =
  { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error'; message: string };

type Tab = 'preview' | 'text' | 'summary';

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
  const [tab, setTab] = useState<Tab>('preview');
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const tabsId = useId();

  const renderable = item !== null && isPreviewable(item.mimeType);

  /**
   * Bumped to refetch. A counter rather than calling a loader directly, so the
   * live handler below stays a plain state update and the fetch itself lives in
   * one effect — every setState then happens after an await, never
   * synchronously in the effect body.
   */
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * The detail request is what carries `extractedText` and `summary`. The list
   * endpoint deliberately omits both — a page of scanned contracts would be
   * megabytes — so opening a document is where they are fetched.
   */
  useEffect(() => {
    if (!item) {
      return;
    }

    let current = true;

    void (async () => {
      try {
        const fresh = await withToken((token) => getDocument(token, item.id));

        if (current) {
          setDetail(fresh);
        }
      } catch {
        // The preview itself still works; the tabs show their empty state.
      }
    })();

    return () => {
      current = false;
    };
  }, [item, withToken, reloadKey]);

  /**
   * A document opened while it is still processing fills in as the worker
   * finishes, without the user reopening it — which is the whole reason the
   * event stream exists.
   */
  useLiveEvent((event) => {
    if (event.type === 'document.status' && event.documentId === item?.id) {
      setReloadKey((key) => key + 1);
    }
  });

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
      <Tabs
        idBase={tabsId}
        label={item.name}
        value={tab}
        onChange={setTab}
        className="mb-4"
        items={[
          { value: 'preview', label: t.processing.tabs.preview },
          {
            value: 'text',
            label: t.processing.tabs.text,
            badge: <StageDot stage={detail?.metadata?.ocrStatus} />,
          },
          {
            value: 'summary',
            label: t.processing.tabs.summary,
            badge: <StageDot stage={detail?.metadata?.aiStatus} />,
          },
        ]}
      />

      <TabPanel idBase={tabsId} value="text" selected={tab}>
        <ExtractedText detail={detail} t={t} />
      </TabPanel>

      <TabPanel idBase={tabsId} value="summary" selected={tab}>
        <Summary detail={detail} t={t} />
      </TabPanel>

      <TabPanel idBase={tabsId} value="preview" selected={tab}>
        {/*
          A format no browser renders — .docx, .xlsx, .pptx.

          It used to stop here with "this file type cannot be previewed", which
          was true of the BYTES but not of the document: v2 extracts the text of
          every one of these, so there is something real to show. The reading
          view is offered instead of a dead end, with the extension called out
          so nobody mistakes it for the original formatting.
        */}
        {!renderable ? (
          <div className="flex flex-col gap-3">
            <div className="border-border bg-surface-inset flex items-center gap-3 rounded-lg border px-4 py-3">
              <span
                aria-hidden="true"
                className="border-border bg-surface text-text-subtle flex size-9 shrink-0 items-center justify-center rounded-lg border text-2xs font-medium tracking-wide uppercase"
              >
                {item.extension.slice(0, 4)}
              </span>

              <p className="text-text-muted text-xs text-balance">{t.preview.textFallback}</p>

              <Button
                variant="secondary"
                size="sm"
                className="ms-auto shrink-0"
                onClick={() => onDownload(item)}
              >
                {t.actions.download}
              </Button>
            </div>

            <ExtractedText detail={detail} t={t} />
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
      </TabPanel>
    </Dialog>
  );
}

/** A dot on a tab, so processing state is visible without opening the tab. */
function StageDot({ stage }: { stage?: string | null }) {
  if (!stage || stage === 'DONE') {
    return null;
  }

  const tone =
    stage === 'FAILED' ? 'bg-danger' : stage === 'SKIPPED' ? 'bg-text-subtle' : 'bg-accent';

  return <span aria-hidden className={`size-1.5 rounded-full ${tone}`} />;
}

/**
 * The text OCR or a document parser produced.
 *
 * Rendered in a mono face inside a scroll region, preserving the line breaks
 * the extractor found — the reading order of a scanned table is information,
 * and reflowing it as prose destroys it.
 */
function ExtractedText({
  detail,
  t,
}: {
  detail: DocumentDetail | null;
  t: Dictionary['documents'];
}) {
  const meta = detail?.metadata;

  if (!detail) {
    return <Skeleton className="h-[50dvh] w-full" />;
  }

  if (meta?.ocrStatus === 'FAILED') {
    return <Notice tone="danger" title={t.processing.failedText} body={meta.ocrError} />;
  }

  if (meta?.ocrStatus === 'SKIPPED') {
    return <Notice title={t.processing.skipped} />;
  }

  if (!meta || meta.ocrStatus === 'PENDING' || meta.ocrStatus === 'QUEUED') {
    return <Notice title={t.processing.pending} />;
  }

  if (meta.ocrStatus === 'RUNNING') {
    return <Notice title={t.processing.running} />;
  }

  if (!meta.extractedText) {
    return <Notice title={t.processing.noText} />;
  }

  return (
    <div>
      {meta.ocrPages ? (
        <p className="text-text-subtle mb-2 text-xs">
          {interpolate(t.processing.pagesRead, { count: String(meta.ocrPages) })}
        </p>
      ) : null}

      <pre className="border-border bg-surface-inset text-text max-h-[60dvh] overflow-auto rounded-lg border p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {meta.extractedText}
      </pre>
    </div>
  );
}

function Summary({ detail, t }: { detail: DocumentDetail | null; t: Dictionary['documents'] }) {
  const meta = detail?.metadata;

  if (!detail) {
    return <Skeleton className="h-40 w-full" />;
  }

  if (meta?.aiStatus === 'FAILED') {
    return <Notice tone="danger" title={t.processing.failedSummary} body={meta.aiError} />;
  }

  if (meta?.aiStatus === 'RUNNING') {
    return <Notice title={t.processing.running} />;
  }

  if (!meta?.summary) {
    return <Notice title={t.processing.noSummary} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-text text-sm leading-relaxed">{meta.summary}</p>

      {meta.keywords.length > 0 ? (
        <div>
          <h3 className="text-text-subtle text-xs font-medium tracking-wide uppercase">
            {t.processing.keywords}
          </h3>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {meta.keywords.map((keyword) => (
              <li key={keyword}>
                <Badge tone="neutral">{keyword}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {meta.aiModel ? (
        <p className="text-text-subtle text-xs">
          {/*
           * Attribution matters here. `null` is the stub provider's name, and a
           * fabricated-looking summary must never be mistaken for real
           * analysis — so it says so rather than quietly presenting it.
           */}
          {meta.aiModel === 'null'
            ? t.processing.stub
            : interpolate(t.processing.model, { model: meta.aiModel })}
        </p>
      ) : null}
    </div>
  );
}

function Notice({
  title,
  body,
  tone = 'neutral',
}: {
  title: string;
  body?: string | null;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div
      className={
        tone === 'danger'
          ? 'border-danger-border bg-danger-subtle rounded-lg border px-6 py-10 text-center'
          : 'border-border bg-surface-inset rounded-lg border px-6 py-10 text-center'
      }
    >
      <p className="text-text-muted text-sm">{title}</p>
      {body ? <p className="text-text-subtle mt-2 font-mono text-xs">{body}</p> : null}
    </div>
  );
}

/*
 * There is deliberately no `canPreview` gate here.
 *
 * The preview is offered for every document — a button that appears and
 * disappears by file type reads as broken — and since v2 there is always
 * something to show: the rendered bytes when a browser can display them, and
 * the extracted text when it cannot.
 */
