import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Serif } from 'next/font/google';
import './globals.css';

/**
 * Type system.
 *
 * IBM Plex, used as a family rather than a single face: the serif carries
 * display copy (a document product should sound editorial), the sans handles
 * UI, and the mono is reserved for identifiers — storage keys, hashes, IDs —
 * where telling 0 from O actually matters.
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

export const metadata: Metadata = {
  title: {
    default: 'DocuFlow AI',
    template: '%s · DocuFlow AI',
  },
  description:
    'Enterprise document management with AI assistance — one secure repository, full version history, and answers drawn from your own files.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf9f6' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1a19' },
  ],
};

/**
 * Applies the stored theme before first paint.
 *
 * This has to run synchronously in <head>: doing it in an effect means the
 * browser paints the system theme first and then repaints, which is a visible
 * white flash for anyone who chose dark. Wrapped in try/catch because
 * localStorage throws outright in some privacy modes.
 */
const THEME_BOOT = `
try {
  var t = localStorage.getItem('docuflow-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexSerif.variable} ${plexMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
