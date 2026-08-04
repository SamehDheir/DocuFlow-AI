import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { ActivityView } from './activity-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.activity.meta.title,
    description: dict.activity.meta.description,
    alternates: {
      canonical: `/${lang}/activity`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/activity`])),
    },
  };
}

export default async function ActivityPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return <ActivityView lang={lang} t={dict.activity} errors={dict.errors} common={dict.common} />;
}
