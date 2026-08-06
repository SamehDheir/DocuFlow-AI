import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { TrashView } from './trash-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.trash.meta.title,
    description: dict.trash.meta.description,
    alternates: {
      canonical: `/${lang}/trash`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/trash`])),
    },
  };
}

export default async function TrashPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    <TrashView
      lang={lang}
      t={dict.trash}
      tDocuments={dict.documents}
      errors={dict.errors}
      common={dict.common}
    />
  );
}
