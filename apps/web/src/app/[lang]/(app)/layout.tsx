import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app/app-shell';
import { ToastProvider } from '@/components/ui/toast';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';

/**
 * Shell for signed-in pages.
 *
 * A server component so the dictionary is loaded once per render and only the
 * requested locale's strings reach the client — AppShell takes them as props
 * rather than importing getDictionary, which is `server-only`.
 */
export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = await getDictionary(lang);

  return (
    <ToastProvider>
      <AppShell
        lang={lang}
        t={dict.app}
        common={dict.common}
        nav={{
          dashboard: dict.dashboard.meta.title,
          documents: dict.documents.title,
          trash: dict.trash.title,
          activity: dict.activity.title,
        }}
      >
        {children}
      </AppShell>
    </ToastProvider>
  );
}
