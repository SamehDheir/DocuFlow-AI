import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DashboardView } from './dashboard-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.dashboard.meta.title,
    description: dict.dashboard.meta.description,
    alternates: {
      canonical: `/${lang}/dashboard`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/dashboard`])),
    },
  };
}

export default async function DashboardPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    <DashboardView
      lang={lang}
      t={dict.dashboard}
      tActivity={dict.activity}
      tDocuments={dict.documents}
      errors={dict.errors}
      common={dict.common}
    />
  );
}
