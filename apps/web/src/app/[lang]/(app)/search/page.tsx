import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { SearchView } from './search-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.search.meta.title,
    description: dict.search.meta.description,
    alternates: {
      canonical: `/${lang}/search`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/search`])),
    },
  };
}

export default async function SearchPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    <SearchView
      lang={lang}
      t={dict.search}
      tDocuments={dict.documents}
      errors={dict.errors}
      common={dict.common}
    />
  );
}
