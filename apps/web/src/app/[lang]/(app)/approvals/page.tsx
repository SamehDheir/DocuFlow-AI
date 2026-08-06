import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { ApprovalsView } from './approvals-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.approvals.meta.title,
    description: dict.approvals.meta.description,
    alternates: {
      canonical: `/${lang}/approvals`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/approvals`])),
    },
  };
}

export default async function ApprovalsPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    <ApprovalsView
      lang={lang}
      t={dict.approvals}
      errors={dict.errors}
      common={dict.common}
      confirm={dict.confirm}
    />
  );
}
