/**
 * Locale configuration.
 *
 * Kept dependency-free and free of `server-only` so it can be imported from
 * proxy.ts, server components and client components alike — the language
 * switcher needs the locale list in the browser.
 */

export const locales = ['en', 'ar'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

/** Writing direction per locale. Arabic is right-to-left. */
export const direction: Record<Locale, 'ltr' | 'rtl'> = {
  en: 'ltr',
  ar: 'rtl',
};

/** Names shown in the language switcher, each written in its own language. */
export const localeNames: Record<Locale, string> = {
  en: 'English',
  ar: 'العربية',
};

/** BCP 47 tags for <html lang> and hreflang. */
export const localeTags: Record<Locale, string> = {
  en: 'en',
  ar: 'ar',
};

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}
