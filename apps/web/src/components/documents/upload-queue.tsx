'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useSession } from '@/components/auth/session-provider';
import type { Dictionary } from '@/i18n/get-dictionary';
import { errorMessage, isCancelled } from '@/lib/error-message';
import { collapse, DURATION, EASE, respectMotion } from '@/lib/motion';
import { uploadDocument, type DocumentSummary, type UploadHandle } from '@/lib/documents';
import { interpolate } from '@/i18n/interpolate';

type ItemState = 'uploading' | 'done' | 'failed';

function DoneGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

function FailedGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M8 4.5v4.5M8 11.5h.01" />
      <circle cx="8" cy="8" r="6.25" strokeWidth="1.25" />
    </svg>
  );
}

interface QueueItem {
  id: number;
  name: string;
  percent: number;
  state: ItemState;
  message?: string;
  handle?: UploadHandle;
}

/**
 * The upload queue.
 *
 * Uploads are per-file rather than one batched request: a single failure in a
 * batch would take the whole selection with it, and the user would have no way
 * to tell which file was the problem. Each row can be cancelled on its own.
 */
export function UploadQueue({
  files,
  folderId,
  t,
  errors,
  common,
  onUploaded,
  onIdle,
}: {
  /** A new array identity starts a new batch. */
  files: File[];
  folderId?: string;
  t: Dictionary['upload'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  onUploaded: (document: DocumentSummary) => void;
  onIdle: () => void;
}) {
  const { withToken } = useSession();
  const reduced = useReducedMotion();
  const [items, setItems] = useState<QueueItem[]>([]);
  const nextId = useRef(0);

  /**
   * Held in a ref so the upload effect does not list these as dependencies —
   * a parent re-render gives them new identities, and re-running that effect
   * would restart every upload in the batch.
   *
   * Synced in an effect rather than during render (writing a ref while
   * rendering is a React violation), and declared BEFORE the upload effect so
   * it is applied first on every commit.
   */
  const callbacks = useRef({ onUploaded, onIdle });

  useEffect(() => {
    callbacks.current = { onUploaded, onIdle };
  }, [onUploaded, onIdle]);

  const update = useCallback((id: number, patch: Partial<QueueItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  /**
   * Batches already sent, tracked by array identity.
   *
   * The effect below POSTs, which makes it the one kind of effect that must be
   * idempotent. React StrictMode deliberately runs setup → cleanup → setup on
   * mount in development, and this effect has no cleanup that could unsend an
   * upload — so without this guard every file was uploaded twice and appeared
   * twice in the queue.
   *
   * Keyed on the array itself, which matches the `files` contract ("a new array
   * identity starts a new batch") and lets finished batches be collected. Refs
   * survive StrictMode's simulated remount, which is precisely why the guard
   * belongs in one rather than in state.
   */
  const sent = useRef(new WeakSet<File[]>());

  useEffect(() => {
    if (files.length === 0 || sent.current.has(files)) return;

    sent.current.add(files);

    const started = files.map((file) => ({
      id: (nextId.current += 1),
      name: file.name,
      percent: 0,
      state: 'uploading' as ItemState,
    }));

    setItems((current) => [...current, ...started]);

    void Promise.all(
      files.map(async (file, index) => {
        const { id } = started[index];

        try {
          /**
           * withToken renews a stale access token once and replays. The handle
           * has to be created INSIDE the callback, because a replay needs a new
           * XHR — the first one has already been sent.
           */
          const document = await withToken((token) => {
            const handle = uploadDocument(token, file, {
              folderId,
              onProgress: (percent) => update(id, { percent }),
            });

            update(id, { handle });

            return handle.done;
          });

          update(id, { state: 'done', percent: 100, handle: undefined });
          callbacks.current.onUploaded(document);
        } catch (error) {
          if (isCancelled(error)) {
            // A cancelled row is removed rather than shown as a failure — the
            // user already knows, they asked for it.
            setItems((current) => current.filter((item) => item.id !== id));
            return;
          }

          update(id, {
            state: 'failed',
            handle: undefined,
            message: errorMessage(error, errors, common.genericError),
          });
        }
      }),
    ).finally(() => callbacks.current.onIdle());
  }, [files, folderId, withToken, update, errors, common.genericError]);

  if (items.length === 0) return null;

  const active = items.filter((item) => item.state === 'uploading').length;

  return (
    <motion.section
      layout
      className="border-border bg-surface-raised rounded-xl border p-4 shadow-sm"
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASE.outExpo }}
      aria-label={t.title}
    >
      <header className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium">{t.title}</h2>

        {active === 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setItems([])}>
            {t.close}
          </Button>
        ) : null}
      </header>

      <ul className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li
              key={item.id}
              layout
              variants={respectMotion(collapse, reduced)}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="flex flex-col gap-1.5"
            >
              <div className="flex items-baseline justify-between gap-3">
                {/* Filenames are frequently Latin inside Arabic copy, so they
                    are isolated to stop the bidi algorithm reordering them. */}
                <span className="latin truncate text-sm" title={item.name}>
                  {item.name}
                </span>

                {item.state === 'uploading' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => item.handle?.cancel()}
                    className="shrink-0"
                  >
                    {t.cancel}
                  </Button>
                ) : (
                  /*
                   * A glyph rather than a text badge: the row already shows the
                   * filename, so repeating "Uploaded report.pdf" beside it is
                   * noise. The full sentence lives in the accessible name,
                   * where it is the only thing a screen reader has.
                   */
                  <span
                    className={item.state === 'failed' ? 'text-danger' : 'text-success'}
                    role="img"
                    aria-label={interpolate(item.state === 'failed' ? t.failed : t.complete, {
                      name: item.name,
                    })}
                  >
                    {item.state === 'failed' ? <FailedGlyph /> : <DoneGlyph />}
                  </span>
                )}
              </div>

              {item.state === 'uploading' ? (
                <Progress
                  value={item.percent}
                  label={interpolate(t.progress, { percent: item.percent })}
                />
              ) : null}

              {item.message ? <p className="text-danger text-xs">{item.message}</p> : null}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </motion.section>
  );
}
