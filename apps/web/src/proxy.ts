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
 * Session routing.
 *
 * The API's refresh cookie is scoped to /api/auth and is therefore invisible
 * here, so it sets a separate path-/ flag purely so this can run. The flag is a
 * hint: it survives revocation and proves nothing. Its only job is to send a
 * navigation somewhere sensible without a flash of the wrong page — every
 * protected read is still authorised by the API against a real token.
 */
const SESSION_COOKIE = 'docuflow_session';

/** Pages that require a session, matched by path after the locale segment. */
const PROTECTED = [
  '/dashboard',
  '/documents',
  '/search',
  '/approvals',
  '/trash',
  '/activity',
  '/members',
];

/**
 * Pages that make no sense once signed in.
 *
 * `/invite` is deliberately absent. It is an auth page, but someone already
 * signed in to one company may legitimately hold an invitation to another, and
 * bouncing them to their own dashboard would make that link impossible to use
 * without signing out first.
 */
const AUTH_ONLY = ['/login', '/register', '/forgot-password'];

function matches(path: string, routes: string[]): boolean {
  return routes.some((route) => path === route || path.startsWith(`${route}/`));
}

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
    const current = pathname.split('/')[1];
    const locale = isLocale(current) ? current : defaultLocale;
    const route = pathname.slice(`/${current}`.length) || '/';
    const signedIn = request.cookies.has(SESSION_COOKIE);

    if (!signedIn && matches(route, PROTECTED)) {
      const url = request.nextUrl.clone();
      url.pathname = `/${locale}/login`;
      // Remembered so signing in resumes where the reader was headed, rather
      // than dumping them on the dashboard and making them navigate again.
      url.searchParams.set('next', pathname);

      return NextResponse.redirect(url);
    }

    if (signedIn && matches(route, AUTH_ONLY)) {
      const url = request.nextUrl.clone();
      url.pathname = `/${locale}/dashboard`;
      url.search = '';

      return NextResponse.redirect(url);
    }

    // Persist the locale the reader is actually browsing, so a manual switch
    // survives the next visit.
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
