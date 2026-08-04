import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@/i18n/config';

/**
 * No marketing page exists yet, so the locale root sends people to the only
 * entry point that works. Replace this with the landing page when it is built —
 * shipping the create-next-app default would violate the design standard in
 * CLAUDE.md and is worse than a redirect.
 *
 * The redirect must keep the locale prefix; sending /ar to /login would drop the
 * reader's language and bounce them through proxy.ts back to a locale chosen by
 * their browser rather than the one they were reading.
 */
export default async function Home({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  redirect(`/${lang}/login`);
}
