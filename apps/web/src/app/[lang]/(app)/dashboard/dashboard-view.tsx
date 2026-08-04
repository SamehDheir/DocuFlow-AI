'use client';

import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { fetchProfile, type Profile } from '@/lib/auth';
import {
  formatBytes,
  getStats,
  listDocuments,
  type DocumentSummary,
  type StorageStats,
} from '@/lib/documents';
import { respectMotion, riseItem, stagger } from '@/lib/motion';

type DashboardStrings = Dictionary['dashboard'];
type CommonStrings = Dictionary['common'];

type State =
  { kind: 'loading' } | { kind: 'ready'; profile: Profile } | { kind: 'error'; message: string };

export function DashboardView({
  lang,
  t,
  common,
}: {
  lang: Locale;
  t: DashboardStrings;
  common: CommonStrings;
}) {
  const { status, withToken } = useSession();
  const reduced = useReducedMotion();
  const router = useRouter();

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [recent, setRecent] = useState<DocumentSummary[]>([]);
  /** Bumped to re-run the effect below; retry is otherwise identical to load. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Waits for the shell to finish restoring; asking sooner would fire a
    // refresh of its own and race the one already in flight.
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        /**
         * The profile decides whether the page renders at all, so it is
         * awaited on its own. Stats and the recent list are decoration on top:
         * if either fails the dashboard still shows who you are and where you
         * work, with em-dashes where the numbers would be.
         */
        const profile = await withToken(fetchProfile);
        if (!current) return;
        setState({ kind: 'ready', profile });

        const [totals, page] = await Promise.all([
          withToken(getStats),
          withToken((token) => listDocuments(token, { limit: 5 })),
        ]);

        if (!current) return;
        setStats(totals);
        setRecent(page.items);
      } catch (error) {
        if (current) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : common.genericError,
          });
        }
      }
    })();

    // A response that arrives after the reader has navigated away, or after a
    // retry superseded this attempt, must not overwrite what is on screen.
    return () => {
      current = false;
    };
  }, [status, attempt, withToken, common.genericError]);

  function retry() {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }

  const variants = respectMotion(riseItem, reduced);

  if (state.kind === 'loading') return <PanelSkeleton label={common.loading} />;

  if (state.kind === 'error') {
    return (
      <div className="rounded-xl border border-danger-border bg-danger-subtle px-6 py-8 text-center">
        <h1 className="font-display text-lg font-semibold">{t.error.title}</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{state.message}</p>
        <Button variant="secondary" className="mt-5" onClick={retry}>
          {t.error.retry}
        </Button>
      </div>
    );
  }

  const { profile } = state;

  return (
    <motion.div variants={stagger} initial="hidden" animate="visible">
      <motion.header variants={variants}>
        <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">
          {t.workspaceLabel}
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {interpolate(t.greeting, { name: profile.firstName })}
        </h1>
        <p className="mt-2.5 text-sm text-text-muted">{t.subtitle}</p>
      </motion.header>

      <motion.dl variants={variants} className="mt-9 grid gap-4 sm:grid-cols-3">
        <Facts label={t.workspaceLabel} value={profile.company.name} hint={profile.company.slug} />
        <Facts label={t.roleLabel} value={profile.roles.join(' · ')} />
        <Facts
          label={t.permissionsLabel}
          value={interpolate(t.permissionsValue, { count: profile.permissions.length })}
        />
      </motion.dl>

      {/*
        Real numbers now that the documents module exists. Storage is the tile
        that answers the question a customer actually asks first, so it leads.
      */}
      <motion.dl variants={variants} className="mt-4 grid gap-4 sm:grid-cols-3">
        <Facts
          label={t.stats.storage}
          value={stats ? formatBytes(stats.storageBytes, lang) : '—'}
        />
        <Facts
          label={t.stats.documents}
          value={stats ? new Intl.NumberFormat(lang).format(stats.documents) : '—'}
        />
        <Facts
          label={t.stats.trashed}
          value={stats ? new Intl.NumberFormat(lang).format(stats.trashed) : '—'}
        />
      </motion.dl>

      <motion.section
        variants={variants}
        className="mt-4 overflow-hidden rounded-xl border border-border bg-surface"
      >
        <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <h2 className="text-sm font-medium">{t.recent.title}</h2>
          <Link
            href={`/${lang}/documents`}
            className="text-accent rounded-md text-xs hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t.recent.viewAll}
          </Link>
        </header>

        {recent.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <FolderMark className="text-text-subtle/45" />
            <p className="mt-5 text-sm text-text-muted">{t.recent.empty}</p>
            <Button className="mt-5" onClick={() => router.push(`/${lang}/documents`)}>
              {t.recent.viewAll}
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {recent.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-5 py-3">
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-inset text-[0.5rem] font-medium uppercase text-text-subtle"
                  aria-hidden="true"
                >
                  {item.extension.slice(0, 4)}
                </span>

                <span className="latin min-w-0 flex-1 truncate text-sm" title={item.name}>
                  {item.name}
                </span>

                <span className="shrink-0 text-xs text-text-subtle">
                  {formatBytes(item.size, lang)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </motion.section>
    </motion.div>
  );
}

function Facts({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-5 py-4">
      <dt className="text-xs font-medium tracking-wide text-text-subtle uppercase">{label}</dt>
      <dd className="mt-1.5 truncate font-display text-lg font-semibold" title={value}>
        {value}
      </dd>
      {hint && <p className="mt-0.5 truncate font-mono text-xs text-text-subtle">{hint}</p>}
    </div>
  );
}

function PanelSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>

      <div className="h-3 w-24 animate-pulse rounded bg-surface-inset" />
      <div className="mt-3 h-9 w-72 max-w-full animate-pulse rounded-lg bg-surface-inset" />
      <div className="mt-3 h-4 w-64 max-w-full animate-pulse rounded bg-surface-inset" />

      <div className="mt-9 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-22 animate-pulse rounded-xl border border-border bg-surface-inset"
          />
        ))}
      </div>

      <div className="mt-4 h-80 animate-pulse rounded-xl border border-border bg-surface-inset" />
    </div>
  );
}

function FolderMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={`size-12 ${className ?? ''}`}
    >
      <path
        d="M5 13a3 3 0 0 1 3-3h9.6a3 3 0 0 1 2.4 1.2l2 2.7a3 3 0 0 0 2.4 1.2H40a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V13Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M5 21h38" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 3" />
    </svg>
  );
}
