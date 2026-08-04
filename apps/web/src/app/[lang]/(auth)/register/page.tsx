import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { RegisterForm } from './register-form';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.register.meta.title,
    description: dict.register.meta.description,
    alternates: {
      canonical: `/${lang}/register`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/register`])),
    },
  };
}

export default async function RegisterPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return <RegisterForm lang={lang} t={dict.register} common={dict.common} />;
}
