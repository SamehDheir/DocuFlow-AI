import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DocumentDetailView } from './document-detail-view';
import Loading from './loading';

/**
 * The metadata is generic on purpose.
 *
 * A document's name is tenant data behind a permission check, and this function
 * runs on the server with no session — reading the name here would mean either
 * an unauthenticated API call or leaking it into a `<title>` that link previews
 * and browser history keep. The heading inside the page shows the real name,
 * after the API has authorised the read.
 *
 * `alternates` deliberately omits a canonical: every id is a different URL and
 * none of them should be indexed.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; id: string }>;
}): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.documents.detail.meta.title,
    description: dict.documents.detail.meta.description,
    robots: { index: false, follow: false },
    alternates: {
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/documents/${id}`])),
    },
  };
}

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ lang: string; id: string }>;
}) {
  const { lang, id } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    /**
     * The view reads `?tab=` with `useSearchParams`, which cannot be resolved
     * during the static prerender. The boundary is what lets the rest of the
     * route prerender anyway instead of the whole page opting into client
     * rendering — the same shape reset-password already uses.
     *
     * The fallback is the route's own `loading.tsx`, so a navigation and a
     * suspended search-params read look identical rather than being two
     * different waiting states for the same page.
     */
    <Suspense fallback={<Loading />}>
      <DocumentDetailView
        id={id}
        lang={lang}
        t={dict.documents}
        tTags={dict.tags}
        tComments={dict.comments}
        errors={dict.errors}
        common={dict.common}
        confirm={dict.confirm}
      />
    </Suspense>
  );
}
