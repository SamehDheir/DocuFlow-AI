'use client';

import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Logo } from '@/components/brand/logo';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { Drawer } from '@/components/ui/drawer';
import { direction, type Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';
import { UserMenu } from './user-menu';

/** Labels for the primary destinations, gathered from their own namespaces. */
interface NavLabels {
  documents: string;
  trash: string;
  dashboard: string;
  activity: string;
  search: string;
  approvals: string;
  members: string;
}

/**
 * The primary destinations, in order, built once for both navigations.
 *
 * Search and Approvals sit next to Documents rather than at the end: both are
 * daily work, where Trash and Activity are places you go when something has
 * gone wrong or needs auditing.
 *
 * Shared rather than written out per navigation — the header and the mobile
 * drawer showing different destinations is the kind of drift nothing catches.
 */
function navLinks(lang: Locale, nav: NavLabels) {
  return [
    { href: `/${lang}/dashboard`, label: nav.dashboard },
    { href: `/${lang}/documents`, label: nav.documents },
    { href: `/${lang}/search`, label: nav.search },
    { href: `/${lang}/approvals`, label: nav.approvals },
    { href: `/${lang}/trash`, label: nav.trash },
    { href: `/${lang}/activity`, label: nav.activity },
    { href: `/${lang}/members`, label: nav.members },
  ];
}

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
  notifications,
  children,
}: {
  lang: Locale;
  t: Dictionary['app'];
  common: Dictionary['common'];
  /** Labels for the primary navigation, from the documents and trash namespaces. */
  nav: NavLabels;
  notifications: Dictionary['notifications'];
  children: React.ReactNode;
}) {
  const { status } = useSession();
  const router = useRouter();
  const reduced = useReducedMotion();
  const pathname = usePathname();

  const [menuOpen, setMenuOpen] = useState(false);

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
          <div className="flex min-w-0 items-center gap-1.5">
            {/*
             * The whole of navigation below `lg`. Rendered only where the tab
             * strip is hidden, so the two are never both present and never
             * both absent.
             */}
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label={t.openMenu}
              aria-expanded={menuOpen}
              className="text-text-muted hover:bg-surface-inset hover:text-text duration-fast ease-out-quint focus-visible:outline-focus -ms-2 flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 lg:hidden"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                className="size-4.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M2 4h12M2 8h12M2 12h12" />
              </svg>
            </button>

            <Link
              href={`/${lang}/dashboard`}
              className="rounded-md transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
            >
              <Logo />
            </Link>
          </div>

          <PrimaryNav lang={lang} nav={nav} />

          <div className="flex items-center gap-1 sm:gap-2">
            {/* Only mounted once the session is real: the bell opens a stream
                and fetches a count, neither of which is meaningful while the
                refresh cookie is still being exchanged. */}
            {status === 'authenticated' ? (
              <NotificationBell lang={lang} t={notifications} common={common} />
            ) : null}
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

      <Drawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={t.menu}
        closeLabel={t.closeMenu}
        rtl={direction[lang] === 'rtl'}
      >
        <MobileNav
          lang={lang}
          nav={nav}
          pathname={pathname}
          onNavigate={() => setMenuOpen(false)}
        />
      </Drawer>
    </div>
  );
}

/**
 * The drawer's copy of the primary navigation.
 *
 * Reads as the same system as the header rather than a second design: the tab
 * strip marks the current page with an accent underline, so this marks it with
 * an accent bar on the inline-start edge — the same cue turned through ninety
 * degrees to suit a vertical list.
 *
 * Rows are 44px tall because this is the touch surface; the header's 30px tabs
 * are a pointer target and the two should not be the same size.
 */
function MobileNav({
  lang,
  nav,
  pathname,
  onNavigate,
}: {
  lang: Locale;
  nav: NavLabels;
  pathname: string;
  /**
   * Closes the drawer. Called from the link rather than from an effect watching
   * the pathname: tapping the current page navigates nowhere, so there would be
   * no change to react to and the drawer would stay open over a page the reader
   * has already asked to see — with the body still scroll-locked behind it.
   */
  onNavigate: () => void;
}) {
  return (
    <nav className="flex flex-col gap-0.5">
      {navLinks(lang, nav).map((link) => {
        const active = pathname === link.href;

        return (
          <Link
            key={link.href}
            href={link.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex min-h-11 items-center rounded-lg px-3.5 text-sm',
              'duration-fast ease-out-quint transition-colors',
              'focus-visible:outline-focus focus-visible:outline-2 focus-visible:-outline-offset-2',
              active
                ? 'bg-accent-subtle text-accent font-medium'
                : 'text-text-muted hover:bg-surface-inset hover:text-text',
            )}
          >
            {active ? (
              <span
                aria-hidden="true"
                className="bg-accent absolute inset-s-0 top-2.5 bottom-2.5 w-0.5 rounded-full"
              />
            ) : null}

            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Primary navigation.
 *
 * `aria-current="page"` rather than colour alone — the active tab has to be
 * identifiable without seeing it, and the underline is drawn with a layout
 * animation so it slides between tabs instead of blinking.
 *
 * Hidden below `lg`, where seven tabs plus the logo plus the account controls
 * do not fit in one 64px row — the hamburger and its drawer take over there,
 * from the same link list. The cut is at `lg` rather than `sm` because the
 * strip does not merely look tight below it, it overflows.
 */
function PrimaryNav({ lang, nav }: { lang: Locale; nav: NavLabels }) {
  const pathname = usePathname();

  return (
    <nav className="hidden items-center gap-1 lg:flex">
      {navLinks(lang, nav).map((link) => {
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
