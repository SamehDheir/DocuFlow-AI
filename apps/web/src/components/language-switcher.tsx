'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { cn } from '@/lib/cn';
import { locales, localeNames, type Locale } from '@/i18n/config';

/**
 * Language switcher.
 *
 * Swaps the locale segment of the current path rather than sending the reader
 * home — someone reading /ar/register expects /en/register, not /en.
 *
 * Rendered as a segmented control instead of a <select>: with exactly two
 * options, a dropdown hides half the choice behind a click, and each label is
 * written in its own language so it is legible to the person who needs it.
 */
export function LanguageSwitcher({ current, className }: { current: Locale; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function switchTo(next: Locale) {
    if (next === current) return;

    // pathname always starts with /<locale> because proxy.ts guarantees it.
    const segments = pathname.split('/');
    segments[1] = next;

    startTransition(() => {
      router.push(segments.join('/'));
      // Refresh so the server components re-render with the new dictionary;
      // without it the URL changes but cached RSC payloads keep the old strings.
      router.refresh();
    });
  }

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-inset p-0.5',
        pending && 'opacity-70',
        className,
      )}
      role="group"
      aria-label={current === 'ar' ? 'اللغة' : 'Language'}
    >
      {locales.map((locale) => {
        const active = locale === current;

        return (
          <button
            key={locale}
            type="button"
            onClick={() => switchTo(locale)}
            aria-current={active ? 'true' : undefined}
            // The label is in the target language, so mark it up as such —
            // otherwise a screen reader announces "العربية" using English
            // pronunciation rules.
            lang={locale}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-fast',
              active ? 'bg-surface text-text shadow-xs' : 'text-text-subtle hover:text-text',
            )}
          >
            {localeNames[locale]}
          </button>
        );
      })}
    </div>
  );
}
