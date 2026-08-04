import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { LoginForm } from './login-form';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.login.meta.title,
    description: dict.login.meta.description,
    alternates: {
      canonical: `/${lang}/login`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/login`])),
    },
  };
}

export default async function LoginPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return <LoginForm lang={lang} t={dict.login} common={dict.common} />;
}
