import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { isLocale, locales } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';
import { DocumentsView } from './documents-view';
import Loading from './loading';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};

  const dict = await getDictionary(lang);

  return {
    title: dict.documents.meta.title,
    description: dict.documents.meta.description,
    alternates: {
      canonical: `/${lang}/documents`,
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/documents`])),
    },
  };
}

export default async function DocumentsPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    /**
     * The view seeds its folder filter from `?folderId=` with `useSearchParams`,
     * which cannot be resolved during the static prerender. Same boundary, same
     * reason, and the same fallback as the route's own `loading.tsx`.
     */
    <Suspense fallback={<Loading />}>
      <DocumentsView
        lang={lang}
        t={dict.documents}
        tUpload={dict.upload}
        tFolders={dict.folders}
        tConfirm={dict.confirm}
        tApprovals={dict.approvals}
        tTags={dict.tags}
        tBulk={dict.bulk}
        errors={dict.errors}
        common={dict.common}
      />
    </Suspense>
  );
}
