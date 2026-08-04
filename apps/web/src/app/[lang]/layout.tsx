import type { Metadata, Viewport } from 'next';
import {
  IBM_Plex_Mono,
  IBM_Plex_Sans,
  IBM_Plex_Sans_Arabic,
  IBM_Plex_Serif,
} from 'next/font/google';
import { notFound } from 'next/navigation';
import { direction, isLocale, localeTags, locales, type Locale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import '../globals.css';

/**
 * Type system.
 *
 * IBM Plex used as a family: serif for display, sans for UI, mono for
 * identifiers (storage keys, hashes) where telling 0 from O matters.
 *
 * IBM Plex Sans Arabic carries the Arabic locale. It is a genuine member of the
 * same superfamily rather than a fallback, so both languages share proportions
 * and weight. Note there is no Arabic serif in Plex — Arabic headings therefore
 * use the Arabic sans at a heavier weight, wired up in globals.css under
 * [dir='rtl'].
 */
const plexSans = IBM_Plex_Sans({
  variable: '--font-plex-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const plexSerif = IBM_Plex_Serif({
  variable: '--font-plex-serif',
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
});

const plexArabic = IBM_Plex_Sans_Arabic({
  variable: '--font-plex-arabic',
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

/** Pre-render both locales at build time rather than on first request. */
export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: {
      default: dict.meta.defaultTitle,
      template: dict.meta.titleTemplate,
    },
    description: dict.meta.description,
    applicationName: dict.meta.siteName,
    // hreflang alternates: tells search engines these are translations of one
    // page rather than duplicate content competing with each other.
    alternates: {
      canonical: `/${lang}`,
      languages: Object.fromEntries(locales.map((l) => [localeTags[l], `/${l}`])),
    },
    openGraph: {
      type: 'website',
      siteName: dict.meta.siteName,
      title: dict.meta.defaultTitle,
      description: dict.meta.description,
      locale: lang === 'ar' ? 'ar_AR' : 'en_US',
      alternateLocale: lang === 'ar' ? 'en_US' : 'ar_AR',
    },
    twitter: {
      card: 'summary_large_image',
      title: dict.meta.defaultTitle,
      description: dict.meta.description,
    },
    robots: {
      // No production deployment exists yet; keep it out of search results
      // until there is something real to index.
      index: false,
      follow: false,
    },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbf9f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0d0a' },
  ],
};

/**
 * Applies the stored theme before first paint.
 *
 * Must run synchronously in <head>: doing it in an effect means the browser
 * paints the system theme first and then repaints, a visible flash for anyone
 * who chose dark. try/catch because localStorage throws outright in some
 * privacy modes.
 */
const THEME_BOOT = `
try {
  var t = localStorage.getItem('docuflow-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
`;

export default async function RootLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;

  // proxy.ts only ever routes known locales here, but the segment is still a
  // free-form string as far as the router is concerned — /xx/login would
  // otherwise render an English page under a bogus lang attribute.
  if (!isLocale(lang)) notFound();

  const locale: Locale = lang;

  return (
    <html
      lang={localeTags[locale]}
      dir={direction[locale]}
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexSerif.variable} ${plexMono.variable} ${plexArabic.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
