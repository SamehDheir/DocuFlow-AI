import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pipeline } from '@/components/auth/pipeline';
import { Logo, LogoMark } from '@/components/brand/logo';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/get-dictionary';

/**
 * Auth shell.
 *
 * Asymmetric split — the brand panel takes the narrower column and the form the
 * wider one. A 50/50 split is the template default and makes the form feel like
 * an afterthought bolted to a poster.
 *
 * The panel is hidden below lg: on a phone it would push the form below the
 * fold, and the form is the only thing anyone came here to use.
 *
 * RTL: insets and margins use LOGICAL properties (-start/-end) rather than
 * left/right, so the entire layout mirrors for Arabic without a second set of
 * rules.
 */
export default async function AuthLayout({
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
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,26rem)_1fr] xl:grid-cols-[minmax(0,30rem)_1fr]">
      {/* ---------------------------------------------------------------- */}
      {/* Brand panel                                                       */}
      {/* ---------------------------------------------------------------- */}
      <aside className="grain brand-panel relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-10 xl:p-12">
        {/* Depth: two off-centre blooms. Centred symmetrical gradients are the
            giveaway of a generated hero. Colours come from --brand-bloom-*
            tokens so they track the accent. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 -inset-s-24 size-120 rounded-full opacity-45 blur-[90px]"
          style={{
            background:
              'radial-gradient(circle, color-mix(in oklch, var(--color-brand-bloom-a) 55%, transparent), transparent 68%)',
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-48 -inset-e-40 size-104 rounded-full opacity-30 blur-[100px]"
          style={{
            background:
              'radial-gradient(circle, color-mix(in oklch, var(--color-brand-bloom-b) 40%, transparent), transparent 70%)',
          }}
        />

        <div className="relative">
          <Link
            href={`/${lang}`}
            className="inline-flex items-center gap-2.5 transition-opacity hover:opacity-80"
          >
            <LogoMark className="h-8 w-8" />
            <span className="latin font-display text-lg leading-none font-semibold tracking-tight">
              Docu<span className="text-accent">Flow</span>
            </span>
          </Link>
        </div>

        <div className="relative">
          <h2 className="font-display text-3xl leading-tight font-semibold text-balance">
            {dict.panel.headline}
          </h2>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/55">
            {dict.panel.subhead}
          </p>

          <Pipeline className="mt-9" stages={dict.panel.stages} />
        </div>

        <div className="relative flex items-center gap-6 text-xs text-white/40">
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 14 14" className="size-3.5 shrink-0" fill="none" aria-hidden="true">
              <path
                d="M7 1.2 12 3.2v3.9c0 3-2.1 5.1-5 5.8-2.9-.7-5-2.8-5-5.8V3.2L7 1.2Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            {dict.panel.isolated}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 14 14" className="size-3.5 shrink-0" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="5.4" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M7 4v3.4l2.2 1.3"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
            {dict.panel.versioned}
          </span>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/* Form column                                                       */}
      {/* ---------------------------------------------------------------- */}
      <main className="relative flex flex-col">
        <header className="flex items-center justify-between gap-3 px-6 py-5 sm:px-10">
          <Link href={`/${lang}`} className="lg:invisible">
            <Logo />
          </Link>
          <div className="flex items-center gap-2">
            <LanguageSwitcher current={lang} />
            <ThemeToggle
              labels={{ toLight: dict.common.switchToLight, toDark: dict.common.switchToDark }}
            />
          </div>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pt-2 pb-16 sm:px-10">
          <div className="w-full max-w-[25rem]">{children}</div>
        </div>
      </main>
    </div>
  );
}
