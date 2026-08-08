import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { ResetPasswordForm } from './reset-password-form';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.reset.meta.title,
    description: dict.reset.meta.description,
    /**
     * Same reasoning as /invite: no canonical, no hreflang, no indexing. The URL
     * is meaningless without the token in its query string, and a crawler that
     * followed a leaked one would spend a single-use credential.
     */
    robots: { index: false, follow: false },
  };
}

export default async function ResetPasswordPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    /**
     * The form reads the reset token with `useSearchParams`, which cannot be
     * resolved during the static prerender. The boundary is what lets the rest
     * of the page prerender anyway and the token arrive on the client, instead
     * of the whole route opting into client rendering.
     */
    <Suspense
      fallback={
        <SkeletonRegion label={dict.common.loading}>
          <Skeleton className="h-8 w-64 max-w-full rounded-lg" />
          <Skeleton className="mt-3 h-4 w-80 max-w-full rounded" />

          <div className="mt-8 flex flex-col gap-5">
            {[0, 1].map((index) => (
              <div key={index}>
                <Skeleton className="mb-1.5 h-3 w-32 rounded" />
                <Skeleton className="h-11 w-full rounded-lg" />
              </div>
            ))}
            <Skeleton className="h-11 w-full rounded-lg" />
          </div>
        </SkeletonRegion>
      }
    >
      <ResetPasswordForm
        lang={lang}
        t={dict.reset}
        register={dict.register}
        common={dict.common}
        errors={dict.errors}
      />
    </Suspense>
  );
}
