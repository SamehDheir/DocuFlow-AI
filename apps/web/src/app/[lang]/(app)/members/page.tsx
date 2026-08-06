import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { MembersView } from './members-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.members.meta.title,
    description: dict.members.meta.description,
    alternates: {
      canonical: `/${lang}/members`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/members`])),
    },
  };
}

export default async function MembersPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    <MembersView
      lang={lang}
      t={dict.members}
      errors={dict.errors}
      common={dict.common}
      confirm={dict.confirm}
    />
  );
}
