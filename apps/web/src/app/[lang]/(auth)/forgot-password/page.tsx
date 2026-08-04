import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { ForgotPasswordForm } from './forgot-password-form';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.forgot.meta.title,
    description: dict.forgot.meta.description,
    alternates: {
      canonical: `/${lang}/forgot-password`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/forgot-password`])),
    },
  };
}

export default async function ForgotPasswordPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return <ForgotPasswordForm lang={lang} t={dict.forgot} common={dict.common} />;
}
