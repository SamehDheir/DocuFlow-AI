import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { defaultLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';

/**
 * 404.
 *
 * NOTE ON LANGUAGE: not-found.tsx receives no params, so the locale of the
 * missing URL is not available here. It renders in the default locale rather
 * than guessing. The <html lang> from the layout still applies, so the page is
 * consistent with the shell around it.
 *
 * Keeping the filing metaphor rather than a shrugging robot: the copy should
 * still sound like this product.
 */
export default async function NotFound() {
  const dict = await getDictionary(defaultLocale);
  const t = dict.notFound;

  return (
    <div className="relative flex min-h-dvh flex-col">
      <header className="px-6 py-5 sm:px-10">
        <Link href={`/${defaultLocale}`} className="inline-block">
          <Logo />
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 pb-24 sm:px-10">
        <div className="w-full max-w-lg text-center">
          {/* The code is decorative at this size — the heading carries the
              meaning, so it is hidden from assistive tech. */}
          <p
            aria-hidden="true"
            className="animate-rise font-display text-[7rem] leading-none font-bold text-transparent [-webkit-text-stroke:1.5px_var(--color-border-strong)] sm:text-[9rem]"
          >
            {t.code}
          </p>

          <h1 className="animate-rise mt-2 font-display text-2xl font-semibold text-balance sm:text-3xl">
            {t.title}
          </h1>

          <p className="animate-rise mx-auto mt-3 max-w-md text-sm leading-relaxed text-text-muted">
            {t.body}
          </p>

          <div className="animate-rise mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href={`/${defaultLocale}/login`}
              className="inline-flex h-11 items-center justify-center rounded-lg bg-accent px-5 text-sm font-medium text-accent-fg shadow-sm transition-colors duration-fast hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {t.signIn}
            </Link>
            <Link
              href={`/${defaultLocale}`}
              className="inline-flex h-11 items-center justify-center rounded-lg border border-border-strong bg-surface px-5 text-sm font-medium text-text shadow-xs transition-colors duration-fast hover:bg-surface-inset"
            >
              {t.home}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
