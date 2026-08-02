import Link from 'next/link';
import { Pipeline } from '@/components/auth/pipeline';
import { Logo, LogoMark } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme-toggle';

/**
 * Auth shell.
 *
 * Asymmetric split — the brand panel takes the narrower column and the form the
 * wider one. A 50/50 split is the template default and makes the form feel like
 * an afterthought bolted to a poster.
 *
 * The panel is hidden below lg: on a phone it would push the form below the
 * fold, and the form is the only thing anyone came here to use.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,26rem)_1fr] xl:grid-cols-[minmax(0,30rem)_1fr]">
      {/* ---------------------------------------------------------------- */}
      {/* Brand panel                                                       */}
      {/* ---------------------------------------------------------------- */}
      <aside className="grain relative hidden overflow-hidden bg-[oklch(0.19_0.014_195)] lg:flex lg:flex-col lg:justify-between lg:p-10 xl:p-12">
        {/* Depth: one warm accent bloom, off-centre. Centred symmetrical
            gradients are the giveaway of a generated hero. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 -left-24 size-[30rem] rounded-full opacity-45 blur-[90px]"
          style={{
            background: 'radial-gradient(circle, oklch(0.62 0.12 195 / 0.55), transparent 68%)',
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-[-10rem] bottom-[-12rem] size-[26rem] rounded-full opacity-30 blur-[100px]"
          style={{
            background: 'radial-gradient(circle, oklch(0.72 0.13 155 / 0.4), transparent 70%)',
          }}
        />

        <div className="relative">
          <Link
            href="/"
            className="inline-flex items-center gap-2.5 text-white transition-opacity hover:opacity-80"
          >
            <LogoMark className="h-8 w-8" />
            <span className="font-display text-lg leading-none font-semibold tracking-tight">
              Docu<span className="text-accent">Flow</span>
            </span>
          </Link>
        </div>

        <div className="relative">
          <h2 className="font-display text-3xl leading-tight font-semibold text-balance text-white">
            Every file accounted for.
          </h2>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/55">
            Upload once. DocuFlow handles the rest — extraction, indexing, and a complete audit
            trail of who touched what.
          </p>

          <Pipeline className="mt-9" />
        </div>

        <div className="relative flex items-center gap-6 text-xs text-white/40">
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 14 14" className="size-3.5" fill="none" aria-hidden="true">
              <path
                d="M7 1.2 12 3.2v3.9c0 3-2.1 5.1-5 5.8-2.9-.7-5-2.8-5-5.8V3.2L7 1.2Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            Isolated per company
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 14 14" className="size-3.5" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="5.4" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M7 4v3.4l2.2 1.3"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
            Full version history
          </span>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/* Form column                                                       */}
      {/* ---------------------------------------------------------------- */}
      <main className="relative flex flex-col">
        <header className="flex items-center justify-between px-6 py-5 sm:px-10">
          <Link href="/" className="lg:invisible">
            <Logo />
          </Link>
          <ThemeToggle />
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pt-2 pb-16 sm:px-10">
          <div className="w-full max-w-[25rem]">{children}</div>
        </div>
      </main>
    </div>
  );
}
