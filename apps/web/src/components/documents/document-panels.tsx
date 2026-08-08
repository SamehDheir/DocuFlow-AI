'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import {
  fetchDocumentBlob,
  isPreviewable,
  type DocumentDetail,
  type DocumentSummary,
} from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';

/**
 * The extraction and analysis panels, shared by the quick-look dialog and the
 * document detail route.
 *
 * These were private to document-preview.tsx. The detail page shows the same
 * things — and it is the page where someone reads a scanned contract properly —
 * so the choice was a second copy or one component. Two renderings of the same
 * processing state is how a document ends up meaning different things on
 * different screens, which the status badge's own comment already warns about.
 *
 * Every one of these is a state machine over `ProcessingStage`, and the ordering
 * of the branches is the design: a failure outranks a pending, and "no text
 * found" is a real answer rather than a spinner that never stops.
 */

/** A dot on a tab, so processing state is visible without opening the tab. */
export function StageDot({ stage }: { stage?: string | null }) {
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
 * Rendered in a mono face inside a scroll region, preserving the line breaks the
 * extractor found — the reading order of a scanned table is information, and
 * reflowing it as prose destroys it.
 */
export function ExtractedText({
  detail,
  t,
  className,
}: {
  detail: DocumentDetail | null;
  t: Dictionary['documents'];
  /** Height differs by host: a dialog is capped, a page can breathe. */
  className?: string;
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

      <pre
        className={
          className ??
          'border-border bg-surface-inset text-text max-h-[60dvh] overflow-auto rounded-lg border p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap'
        }
      >
        {meta.extractedText}
      </pre>
    </div>
  );
}

export function Summary({
  detail,
  t,
}: {
  detail: DocumentDetail | null;
  t: Dictionary['documents'];
}) {
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

type BytesState =
  { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error'; message: string };

/**
 * The document itself, rendered from its bytes.
 *
 * Owns the object URL and its revocation, which is the part that is easy to get
 * wrong twice: the blob pins the whole file in memory until it is released, and
 * a component unmounted mid-fetch has already run its cleanup and will never see
 * the URL that arrives afterwards — so that case revokes inline.
 *
 * The bytes come through the API rather than a storage URL, for the same reason
 * downloads do: the API issues no presigned URLs, so every read stays behind the
 * same permission check.
 */
export function DocumentBytes({
  item,
  detail,
  t,
  errors,
  common,
  onDownload,
  height = 'h-[70dvh]',
}: {
  item: Pick<DocumentSummary, 'id' | 'name' | 'mimeType' | 'extension'>;
  detail: DocumentDetail | null;
  t: Dictionary['documents'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  onDownload: () => void;
  height?: string;
}) {
  const { withToken } = useSession();
  const [state, setState] = useState<BytesState>({ kind: 'loading' });

  const renderable = isPreviewable(item.mimeType);
  const image = item.mimeType.startsWith('image/');

  useEffect(() => {
    /**
     * A type the API will not stream inline is never fetched at all — the
     * request would only come back 400 PREVIEW_NOT_AVAILABLE. The reading view
     * below is offered instead of a dead end, because v2 extracts the text of
     * every one of those formats. That state is derived at render time, so
     * nothing is set here.
     */
    if (!renderable) return;

    let url: string | undefined;
    let current = true;

    void (async () => {
      try {
        const objectUrl = await withToken((token) => fetchDocumentBlob(token, item.id, true));

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
  }, [item.id, renderable, withToken, errors, common.genericError]);

  if (!renderable) {
    return (
      <div className="flex flex-col gap-3">
        <div className="border-border bg-surface-inset flex items-center gap-3 rounded-lg border px-4 py-3">
          <span
            aria-hidden="true"
            className="border-border bg-surface text-text-subtle text-2xs flex size-9 shrink-0 items-center justify-center rounded-lg border font-medium tracking-wide uppercase"
          >
            {item.extension.slice(0, 4)}
          </span>

          <p className="text-text-muted text-xs text-balance">{t.preview.textFallback}</p>

          <Button variant="secondary" size="sm" className="ms-auto shrink-0" onClick={onDownload}>
            {t.actions.download}
          </Button>
        </div>

        <ExtractedText detail={detail} t={t} />
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div
        className={`bg-surface-inset w-full animate-pulse rounded-lg ${height}`}
        aria-busy="true"
        aria-live="polite"
      >
        <span className="sr-only">{t.preview.loading}</span>
      </div>
    );
  }

  if (state.kind === 'error') {
    return <Notice tone="danger" title={state.message} />;
  }

  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a blob: URL cannot go through next/image, which needs a resolvable source.
      <img
        src={state.url}
        alt={item.name}
        className={`mx-auto w-auto rounded-lg object-contain ${height.replace('h-', 'max-h-')}`}
      />
    );
  }

  return (
    /*
     * No `sandbox` attribute, which needs justifying.
     *
     * A sandboxed frame gets an opaque origin, and a blob: URL can only be read
     * by the origin that minted it — so `sandbox=""` meant the frame could never
     * load this at all, which Chrome reports as "This page has been blocked".
     *
     * What replaces it is control of the TYPE rather than the frame: the blob is
     * re-wrapped in fetchDocumentBlob with a MIME type from our own allowlist,
     * never from the response. That is the part that matters, because
     * `documents.mime_type` ultimately came from the uploading client — bytes
     * that are really HTML, stored as application/pdf, would otherwise render as
     * HTML in our origin. Forced to application/pdf they reach the PDF viewer
     * and fail to parse, which is the correct outcome.
     */
    <iframe
      src={state.url}
      title={item.name}
      className={`border-border w-full rounded-lg border ${height}`}
    />
  );
}

export function Notice({
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
