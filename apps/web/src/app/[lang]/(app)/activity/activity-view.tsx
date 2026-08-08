'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ActivityRow } from '@/components/activity/activity-row';
import { useSession } from '@/components/auth/session-provider';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { listActivity, listActivityActions, type ActivityEntry } from '@/lib/activity';
import { errorMessage } from '@/lib/error-message';
import { respectMotion, riseItem, stagger } from '@/lib/motion';

type Load = 'loading' | 'ready' | 'error';

/** Entity types the trail records, for the type filter. */
const ENTITY_TYPES = ['Document', 'Folder', 'User', 'Company', 'RefreshToken'] as const;

export function ActivityView({
  lang,
  t,
  errors,
  common,
}: {
  lang: Locale;
  t: Dictionary['activity'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
}) {
  const { status, withToken } = useSession();
  const reduced = useReducedMotion();

  const [load, setLoad] = useState<Load>('loading');
  const [message, setMessage] = useState('');
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Bumped to re-run the load effect; retry is otherwise identical to load. */
  const [attempt, setAttempt] = useState(0);

  /** Offered in the filter, and only the ones this company has actually done. */
  const [actions, setActions] = useState<string[]>([]);
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');

  const filtered = action !== '' || entityType !== '';

  useEffect(() => {
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        const page = await withToken((token) => listActivity(token, { action, entityType }));

        // A stale response must not overwrite a newer one — the filter may have
        // changed twice while the first request was in flight.
        if (!current) return;

        setEntries(page.items);
        setCursor(page.nextCursor);
        setLoad('ready');
      } catch (error) {
        if (!current) return;
        setMessage(errorMessage(error, errors, common.genericError));
        setLoad('error');
      }
    })();

    return () => {
      current = false;
    };
  }, [status, withToken, action, entityType, attempt, errors, common.genericError]);

  // The action list is fetched once: it describes the company, not the filter.
  useEffect(() => {
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        const available = await withToken(listActivityActions);
        if (current) setActions(available);
      } catch {
        // A missing filter list is not worth an error state — the trail below
        // is the point, and it loads on its own.
      }
    })();

    return () => {
      current = false;
    };
  }, [status, withToken]);

  async function loadMore() {
    if (!cursor || loadingMore) return;

    setLoadingMore(true);

    try {
      const page = await withToken((token) => listActivity(token, { action, entityType, cursor }));
      setEntries((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setMessage(errorMessage(error, errors, common.genericError));
    } finally {
      setLoadingMore(false);
    }
  }

  const variants = respectMotion(riseItem, reduced);

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <PageHeader variants={variants} eyebrow={t.title} title={t.title} description={t.subtitle} />

      <motion.div variants={variants} className="flex flex-wrap items-end gap-3">
        <Field label={t.filters.action}>
          <select
            value={action}
            onChange={(event) => setAction(event.target.value)}
            className="border-border bg-surface focus-visible:outline-focus h-11 min-w-44 rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <option value="">{t.filters.allActions}</option>
            {actions.map((name) => (
              <option key={name} value={name}>
                {t.actions[name as keyof typeof t.actions] ?? name}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t.filters.entity}>
          <select
            value={entityType}
            onChange={(event) => setEntityType(event.target.value)}
            className="border-border bg-surface focus-visible:outline-focus h-11 min-w-44 rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <option value="">{t.filters.allEntities}</option>
            {ENTITY_TYPES.map((name) => (
              <option key={name} value={name}>
                {t.entities[name]}
              </option>
            ))}
          </select>
        </Field>

        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setAction('');
              setEntityType('');
            }}
          >
            {t.filters.clear}
          </Button>
        ) : null}
      </motion.div>

      <motion.div variants={variants}>
        {load === 'loading' ? (
          <SkeletonRegion
            label={t.loading}
            className="border-border bg-surface rounded-xl border p-5"
          >
            <div className="flex flex-col gap-4">
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="flex items-start gap-3">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <Skeleton
                    className="h-4 flex-1"
                    style={{ maxWidth: `${45 + ((index * 17) % 40)}%` }}
                  />
                  <Skeleton className="h-3 w-16 shrink-0" />
                </div>
              ))}
            </div>
          </SkeletonRegion>
        ) : null}

        {load === 'error' ? (
          <div className="border-danger-border bg-danger-subtle rounded-xl border px-6 py-10 text-center">
            <h2 className="font-display text-lg">{t.error.title}</h2>
            <p className="text-text-muted mt-2 text-sm">{message}</p>
            <Button
              variant="secondary"
              className="mt-5"
              onClick={() => {
                setLoad('loading');
                setAttempt((value) => value + 1);
              }}
            >
              {t.error.retry}
            </Button>
          </div>
        ) : null}

        {load === 'ready' && entries.length === 0 ? (
          <EmptyState
            icon={<TrailGlyph />}
            title={filtered ? t.emptyFiltered.title : t.empty.title}
            body={filtered ? t.emptyFiltered.body : t.empty.body}
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAction('');
                    setEntityType('');
                  }}
                >
                  {t.filters.clear}
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {load === 'ready' && entries.length > 0 ? (
          <>
            <div className="border-border bg-surface overflow-hidden rounded-xl border">
              <ul className="divide-border divide-y">
                {entries.map((entry) => (
                  <ActivityRow key={entry.id} entry={entry} locale={lang} t={t} />
                ))}
              </ul>
            </div>

            {cursor ? (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {t.loadMore}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </motion.div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-text-subtle text-xs font-medium tracking-wide uppercase">{label}</span>
      {children}
    </label>
  );
}

function TrailGlyph() {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" className="size-12">
      <circle cx="12" cy="14" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="34" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 17.2v13.6" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 3" />
      <path
        d="M21 12h18M21 17h11M21 32h18M21 37h9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
