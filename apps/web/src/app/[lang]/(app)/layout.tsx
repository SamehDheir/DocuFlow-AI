import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app/app-shell';
import { LiveProvider } from '@/components/providers/live-provider';
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
      {/*
       * LiveProvider wraps the shell, not the page: one SSE connection serves
       * every signed-in view, and it must survive client-side navigation
       * between them. Mounting it per page would reconnect on every route
       * change and drop events during the gap.
       */}
      <LiveProvider>
        <AppShell
          lang={lang}
          t={dict.app}
          common={dict.common}
          notifications={dict.notifications}
          nav={{
            dashboard: dict.dashboard.meta.title,
            documents: dict.documents.title,
            search: dict.search.title,
            approvals: dict.approvals.title,
            trash: dict.trash.title,
            activity: dict.activity.title,
            members: dict.members.title,
          }}
        >
          {children}
        </AppShell>
      </LiveProvider>
    </ToastProvider>
  );
}
