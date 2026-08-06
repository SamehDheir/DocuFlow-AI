import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { AcceptInviteForm } from './accept-invite-form';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.invite.meta.title,
    description: dict.invite.meta.description,
    /**
     * No canonical or hreflang, and indexing is refused outright. The URL is
     * meaningless without the token in its query string, and a crawler that
     * followed a leaked one would burn a single-use credential.
     */
    robots: { index: false, follow: false },
  };
}

export default async function InvitePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    <AcceptInviteForm
      lang={lang}
      t={dict.invite}
      register={dict.register}
      common={dict.common}
      errors={dict.errors}
    />
  );
}
