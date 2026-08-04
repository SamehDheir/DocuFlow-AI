'use client';

import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Logo } from '@/components/brand/logo';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { DURATION, EASE } from '@/lib/motion';
import { UserMenu } from './user-menu';

/**
 * Chrome for every signed-in page.
 *
 * Also the second half of route protection. proxy.ts turns away navigations
 * with no session cookie, but that cookie outlives revocation — a refresh token
 * killed by reuse detection leaves it sitting there. So the real check is here,
 * against a session that actually restored.
 */
export function AppShell({
  lang,
  t,
  common,
  nav,
  children,
}: {
  lang: Locale;
  t: Dictionary['app'];
  common: Dictionary['common'];
  /** Labels for the primary navigation, from the documents and trash namespaces. */
  nav: { documents: string; trash: string; dashboard: string };
  children: React.ReactNode;
}) {
  const { status } = useSession();
  const router = useRouter();
  const reduced = useReducedMotion();

  useEffect(() => {
    if (status === 'anonymous') router.replace(`/${lang}/login`);
  }, [status, lang, router]);

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Keyboard users reach the content without tabbing the whole header. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-3 focus:rounded-lg focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm focus:shadow-md focus:outline-2 focus:outline-offset-2 focus:outline-focus"
      >
        {t.skipToContent}
      </a>

      <header className="sticky top-0 z-30 border-b border-border bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-6 sm:px-8">
          <Link
            href={`/${lang}/dashboard`}
            className="rounded-md transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
          >
            <Logo />
          </Link>

          <PrimaryNav lang={lang} nav={nav} />

          <div className="flex items-center gap-2">
            <LanguageSwitcher current={lang} />
            <ThemeToggle labels={{ toLight: common.switchToLight, toDark: common.switchToDark }} />
            <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <UserMenu lang={lang} t={t} />
          </div>
        </div>
      </header>

      <motion.main
        id="main"
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: DURATION.slow, ease: EASE.outExpo }}
        className="mx-auto w-full max-w-6xl flex-1 px-6 py-10 sm:px-8 sm:py-14"
      >
        {status === 'restoring' ? <ShellSkeleton label={t.restoring} /> : children}
      </motion.main>
    </div>
  );
}

/**
 * Primary navigation.
 *
 * `aria-current="page"` rather than colour alone — the active tab has to be
 * identifiable without seeing it, and the underline is drawn with a layout
 * animation so it slides between tabs instead of blinking.
 *
 * Hidden below `sm`, where the header has no room; the folder sidebar and the
 * dashboard's own links cover navigation there.
 */
function PrimaryNav({
  lang,
  nav,
}: {
  lang: Locale;
  nav: { documents: string; trash: string; dashboard: string };
}) {
  const pathname = usePathname();

  const links = [
    { href: `/${lang}/dashboard`, label: nav.dashboard },
    { href: `/${lang}/documents`, label: nav.documents },
    { href: `/${lang}/trash`, label: nav.trash },
  ];

  return (
    <nav className="hidden items-center gap-1 sm:flex">
      {links.map((link) => {
        const active = pathname === link.href;

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'text-text relative rounded-md px-3 py-1.5 text-sm font-medium'
                : 'text-text-muted hover:text-text relative rounded-md px-3 py-1.5 text-sm transition-colors'
            }
          >
            {link.label}

            {active ? (
              <motion.span
                layoutId="nav-underline"
                className="bg-accent absolute inset-x-3 -bottom-px h-0.5 rounded-full"
                transition={{ duration: DURATION.base, ease: EASE.outExpo }}
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Shown while the refresh cookie is being exchanged on a cold load.
 *
 * A skeleton in the shape of the real page rather than a spinner: the layout
 * does not jump when the content lands, so the wait reads as loading rather
 * than as a redraw.
 */
function ShellSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>

      <div className="h-8 w-64 max-w-full animate-pulse rounded-lg bg-surface-inset" />
      <div className="mt-3 h-4 w-80 max-w-full animate-pulse rounded bg-surface-inset" />

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-28 animate-pulse rounded-xl border border-border bg-surface-inset"
          />
        ))}
      </div>

      <div className="mt-4 h-56 animate-pulse rounded-xl border border-border bg-surface-inset" />
    </div>
  );
}
