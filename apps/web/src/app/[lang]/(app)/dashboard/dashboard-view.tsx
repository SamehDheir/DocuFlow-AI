'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Button } from '@/components/ui/button';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { fetchProfile, type Profile } from '@/lib/auth';
import { respectMotion, riseItem, stagger } from '@/lib/motion';

type DashboardStrings = Dictionary['dashboard'];
type CommonStrings = Dictionary['common'];

type State =
  { kind: 'loading' } | { kind: 'ready'; profile: Profile } | { kind: 'error'; message: string };

export function DashboardView({ t, common }: { t: DashboardStrings; common: CommonStrings }) {
  const { status, withToken } = useSession();
  const reduced = useReducedMotion();

  const [state, setState] = useState<State>({ kind: 'loading' });
  /** Bumped to re-run the effect below; retry is otherwise identical to load. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Waits for the shell to finish restoring; asking sooner would fire a
    // refresh of its own and race the one already in flight.
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        const profile = await withToken(fetchProfile);
        if (current) setState({ kind: 'ready', profile });
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
        Counts are omitted rather than shown as zero. There is no documents
        module yet, so a "0 documents" tile would be a number the product cannot
        stand behind — it reads as data when it is really absence of a feature.
      */}
      <motion.section
        variants={variants}
        className="mt-4 overflow-hidden rounded-xl border border-border bg-surface"
      >
        <div className="flex flex-col items-center px-6 py-16 text-center">
          <FolderMark className="text-text-subtle/45" />

          <span className="mt-6 inline-flex items-center rounded-full border border-accent-border bg-accent-subtle px-2.5 py-1 text-2xs font-medium tracking-wide text-accent uppercase">
            {t.empty.badge}
          </span>

          <h2 className="mt-4 font-display text-xl font-semibold tracking-tight">
            {t.empty.title}
          </h2>
          <p className="mt-2.5 max-w-md text-sm leading-relaxed text-text-muted">{t.empty.body}</p>

          <ul className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-text-subtle">
            {[t.stats.documents, t.stats.storage, t.stats.members].map((item) => (
              <li key={item} className="inline-flex items-center gap-1.5">
                <span className="size-1 rounded-full bg-border-strong" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
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
