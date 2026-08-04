import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale, isLocale, locales, type Locale } from '@/i18n/config';

/**
 * Locale routing.
 *
 * NOTE ON THE FILENAME: in Next 16 the `middleware` file convention is
 * deprecated and renamed to `proxy`, with the export renamed to match. A file
 * called middleware.ts would be the wrong convention here.
 *
 * Every page lives under /[lang], so any request without a locale prefix is
 * redirected to one. The chosen locale is remembered in a cookie so a reader who
 * picked Arabic is not thrown back to English by their browser's Accept-Language
 * on the next visit.
 */

const COOKIE = 'docuflow-locale';
/** One year, refreshed on every visit that carries the cookie. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Pick a locale from Accept-Language.
 *
 * Hand-rolled rather than pulling in Negotiator + intl-localematcher: with two
 * locales and no regional variants, the full negotiation algorithm buys nothing
 * that this does not already cover. Quality values are respected so
 * `ar;q=0.9, en;q=0.8` resolves to Arabic rather than to whichever appears first.
 */
function localeFromHeader(header: string | null): Locale | undefined {
  if (!header) return undefined;

  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      const quality = q ? Number.parseFloat(q.split('=')[1]) : 1;
      return { tag: tag.trim().toLowerCase(), quality: Number.isNaN(quality) ? 0 : quality };
    })
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    // Match the base language so ar-EG, ar-SA and en-GB all resolve.
    const base = tag.split('-')[0];
    if (isLocale(base)) return base;
  }

  return undefined;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const hasLocale = locales.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );

  if (hasLocale) {
    // Persist the locale the reader is actually browsing, so a manual switch
    // survives the next visit.
    const current = pathname.split('/')[1];
    const response = NextResponse.next();

    if (isLocale(current) && request.cookies.get(COOKIE)?.value !== current) {
      response.cookies.set(COOKIE, current, { maxAge: COOKIE_MAX_AGE, sameSite: 'lax', path: '/' });
    }

    return response;
  }

  const cookieLocale = request.cookies.get(COOKIE)?.value;
  const locale =
    (cookieLocale && isLocale(cookieLocale) ? cookieLocale : undefined) ??
    localeFromHeader(request.headers.get('accept-language')) ??
    defaultLocale;

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;

  return NextResponse.redirect(url);
}

export const config = {
  /**
   * Skip Next internals, the health route handler, and anything that looks like
   * a static file. Prefixing /api/health with a locale would break the probe
   * that docker-compose and the Dockerfile HEALTHCHECK depend on.
   */
  matcher: ['/((?!_next/static|_next/image|api/|favicon.ico|icon|apple-icon|.*\\..*).*)'],
};
