'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { DocumentPreview } from '@/components/documents/document-preview';
import { DocumentStatusBadge } from '@/components/documents/document-status';
import { Button } from '@/components/ui/button';
import { EmptyState, DocumentGlyph } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';
import { TextField } from '@/components/ui/text-field';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { cn } from '@/lib/cn';
import { formatBytes, type DocumentSummary } from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { respectMotion, riseItem, stagger } from '@/lib/motion';
import { searchDocuments, type SearchHit } from '@/lib/search';
import { useDocumentDownload } from '@/lib/use-download';

type Load = 'idle' | 'loading' | 'ready' | 'error';

/** Matches the documents list, so typing feels the same on both screens. */
const DEBOUNCE_MS = 300;

export function SearchView({
  lang,
  t,
  tDocuments,
  errors,
  common,
}: {
  lang: Locale;
  t: Dictionary['search'];
  tDocuments: Dictionary['documents'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
}) {
  const { status, withToken } = useSession();
  const download = useDocumentDownload(errors, common);
  const reduced = useReducedMotion();
  const variants = respectMotion(riseItem, reduced);

  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [previewing, setPreviewing] = useState<DocumentSummary | null>(null);

  /**
   * Which term the results on screen belong to. Everything about the view's
   * phase is derived from this rather than stored in a `load` state, because a
   * separate flag would have to be set synchronously in the effect that starts
   * the search — which is precisely the cascading-render pattern React's
   * compiler lint rejects, and which the rest of this app already avoids.
   */
  const [resultsFor, setResultsFor] = useState<string | null>(null);

  const load: Load =
    query === ''
      ? 'idle'
      : message && resultsFor === query
        ? 'error'
        : resultsFor === query
          ? 'ready'
          : 'loading';

  // Debounced so a query is not issued per keystroke — full-text ranking is far
  // more expensive than the filename filter on the documents list.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  /**
   * Guards against an older response overwriting a newer one. Typing quickly
   * issues overlapping requests, and they do not necessarily come back in the
   * order they were sent — without this, a slow two-character query can land
   * after a fast ten-character one and replace better results with worse.
   */
  const latest = useRef(0);

  /** Bumped by the retry button to re-run the current query. */
  const [retryKey, setRetryKey] = useState(0);

  /**
   * The fetch lives inline in the effect rather than in a `useCallback` the
   * effect calls. Every setState then provably happens after an await, which is
   * both what React's compiler lint requires and the pattern the documents list
   * already uses.
   */
  useEffect(() => {
    if (status !== 'authenticated' || query === '') {
      return;
    }

    const ticket = ++latest.current;

    void (async () => {
      try {
        const results = await withToken((token) => searchDocuments(token, query));

        // A stale response must never replace a newer one.
        if (ticket !== latest.current) {
          return;
        }

        setHits(results.items);
        setNextOffset(results.nextOffset);
        setMessage('');
        setResultsFor(query);
      } catch (error) {
        if (ticket !== latest.current) {
          return;
        }

        setMessage(errorMessage(error, errors, common.genericError));
        setResultsFor(query);
      }
    })();
  }, [status, query, retryKey, withToken, errors, common.genericError]);

  const loadMore = async () => {
    if (nextOffset === null) {
      return;
    }

    try {
      const results = await withToken((token) =>
        searchDocuments(token, query, { offset: nextOffset }),
      );
      setHits((current) => [...current, ...results.items]);
      setNextOffset(results.nextOffset);
    } catch (error) {
      setMessage(errorMessage(error, errors, common.genericError));
      setResultsFor(query);
    }
  };

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <motion.header variants={variants}>
        <p className="text-text-subtle text-xs font-medium tracking-wide uppercase">{t.title}</p>
        <h1 className="font-display mt-1 text-3xl tracking-tight text-balance sm:text-4xl">
          {t.title}
        </h1>
        <p className="text-text-muted mt-2 max-w-2xl text-sm">{t.subtitle}</p>
      </motion.header>

      <motion.div variants={variants}>
        <TextField
          type="search"
          label={t.label}
          hint={t.hint}
          placeholder={t.placeholder}
          value={input}
          autoFocus
          onChange={(event) => setInput(event.target.value)}
        />
      </motion.div>

      <motion.section variants={variants} aria-live="polite">
        {load === 'idle' ? (
          <EmptyState icon={<DocumentGlyph />} title={t.idle.title} body={t.idle.body} />
        ) : load === 'error' ? (
          <div className="border-danger-border bg-danger-subtle rounded-xl border px-6 py-10 text-center">
            <h2 className="font-display text-lg">{t.error.title}</h2>
            <p className="text-text-muted mt-2 text-sm">{message}</p>
            <Button
              variant="secondary"
              className="mt-5"
              onClick={() => {
                setResultsFor(null);
                setRetryKey((key) => key + 1);
              }}
            >
              {t.error.retry}
            </Button>
          </div>
        ) : load === 'loading' && hits.length === 0 ? (
          <SkeletonRegion label={t.loading} className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="border-border rounded-xl border p-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-4/5" />
              </div>
            ))}
          </SkeletonRegion>
        ) : hits.length === 0 ? (
          <EmptyState
            icon={<DocumentGlyph />}
            title={t.empty.title}
            body={interpolate(t.empty.body, { query })}
          />
        ) : (
          <>
            <p className="text-text-muted mb-4 text-sm">
              {hits.length === 1
                ? t.resultsOne
                : interpolate(t.resultsMany, { count: String(hits.length) })}
            </p>

            <ul className="flex flex-col gap-3">
              <AnimatePresence initial={false}>
                {hits.map((hit) => (
                  <ResultCard
                    key={hit.id}
                    hit={hit}
                    lang={lang}
                    tDocuments={tDocuments}
                    onOpen={() => setPreviewing(toSummary(hit))}
                  />
                ))}
              </AnimatePresence>
            </ul>

            {nextOffset !== null ? (
              <div className="mt-6 text-center">
                <Button variant="secondary" onClick={() => void loadMore()}>
                  {t.loadMore}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </motion.section>

      <DocumentPreview
        key={previewing?.id ?? 'none'}
        item={previewing}
        onClose={() => setPreviewing(null)}
        t={tDocuments}
        errors={errors}
        common={common}
        onDownload={(item) => void download(item)}
      />
    </motion.div>
  );
}

function ResultCard({
  hit,
  lang,
  tDocuments,
  onOpen,
}: {
  hit: SearchHit;
  lang: Locale;
  tDocuments: Dictionary['documents'];
  onOpen: () => void;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.li
      layout
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="border-border bg-surface hover:border-border-strong rounded-xl border transition-colors"
    >
      <button
        type="button"
        onClick={onOpen}
        className="focus-visible:ring-focus w-full rounded-xl p-4 text-start focus-visible:ring-2 focus-visible:outline-none"
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* `.latin` isolates a Latin filename inside Arabic copy, so it does
              not get reordered by the bidi algorithm. */}
          <span className="latin text-text truncate text-sm font-medium">{hit.name}</span>

          <DocumentStatusBadge
            status={hit.status}
            ocrStatus={hit.ocrStatus}
            aiStatus={hit.aiStatus}
            t={tDocuments}
          />

          <span className="text-text-subtle ms-auto text-xs">{formatBytes(hit.size, lang)}</span>
        </div>

        {hit.snippet ? (
          <p className="text-text-muted mt-2 text-sm leading-relaxed">
            {/*
             * Rendered from structured parts, not from server-built markup.
             * The API returns `{ text, match }` runs precisely so the highlight
             * can never smuggle HTML out of a document's own contents — React
             * escapes every text node here by construction.
             */}
            {hit.snippet.map((part, index) => (
              <span
                key={index}
                className={cn(
                  part.match && 'bg-accent-subtle text-accent rounded-sm px-0.5 font-medium',
                )}
              >
                {part.text}
              </span>
            ))}
            {'…'}
          </p>
        ) : hit.summary ? (
          <p className="text-text-muted mt-2 line-clamp-2 text-sm leading-relaxed">{hit.summary}</p>
        ) : null}
      </button>
    </motion.li>
  );
}

/**
 * A search hit carries everything the preview needs except the two fields the
 * search projection has no use for, so they are filled in rather than fetched.
 */
function toSummary(hit: SearchHit): DocumentSummary {
  return {
    id: hit.id,
    name: hit.name,
    originalName: hit.originalName,
    mimeType: hit.mimeType,
    extension: hit.extension,
    size: hit.size,
    status: hit.status,
    folderId: hit.folderId,
    ownerId: hit.ownerId,
    hash: null,
    createdAt: hit.createdAt,
    updatedAt: hit.updatedAt,
    deletedAt: null,
  };
}
