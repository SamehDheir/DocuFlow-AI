/**
 * Loading state for the auth routes.
 *
 * Skeletons rather than a spinner, matching the design standard in CLAUDE.md: a
 * skeleton that mirrors the real layout communicates what is arriving and holds
 * the space, so nothing jumps when content lands. A centred spinner tells the
 * reader only that something is happening.
 *
 * It lives in `(auth)` rather than a segment up. At `[lang]/` it was the
 * fallback for every route below it, so opening the dashboard flashed the shape
 * of a sign-in form — a skeleton that mirrors the wrong layout is worse than
 * none, because it makes a promise the page does not keep.
 *
 * This is a server component with no props — it cannot read the dictionary
 * (params are not available to loading.tsx), so it deliberately contains no
 * translatable text. The only announcement is via aria-label on the region,
 * which is set from the html lang by screen readers reading the visual skeleton
 * as busy.
 */
export default function Loading() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,26rem)_1fr] xl:grid-cols-[minmax(0,30rem)_1fr]">
      {/* Brand panel placeholder — real background, since it is not data-dependent */}
      <aside className="grain brand-panel relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-10 xl:p-12">
        <div className="h-8 w-36 animate-pulse rounded-md bg-white/10" />

        <div className="space-y-4">
          <div className="h-8 w-4/5 animate-pulse rounded-md bg-white/10" />
          <div className="h-4 w-full animate-pulse rounded-md bg-white/[0.07]" />
          <div className="h-4 w-2/3 animate-pulse rounded-md bg-white/[0.07]" />

          <div className="space-y-5 pt-6">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-start gap-4">
                <span className="mt-1 size-2.25 shrink-0 animate-pulse rounded-full bg-white/20" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-28 animate-pulse rounded bg-white/10" />
                  <div className="h-3 w-44 animate-pulse rounded bg-white/[0.06]" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="h-3 w-52 animate-pulse rounded bg-white/[0.07]" />
      </aside>

      {/* Form column placeholder */}
      <main className="relative flex flex-col" role="status" aria-busy="true" aria-label="Loading">
        <header className="flex items-center justify-between px-6 py-5 sm:px-10">
          <div className="h-8 w-32 animate-pulse rounded-md bg-surface-inset lg:invisible" />
          <div className="ms-auto flex items-center gap-2">
            <div className="h-8 w-32 animate-pulse rounded-lg bg-surface-inset" />
            <div className="size-9 animate-pulse rounded-lg bg-surface-inset" />
          </div>
        </header>

        <div className="flex flex-1 items-center justify-center px-6 pt-2 pb-16 sm:px-10">
          <div className="w-full max-w-[25rem]">
            <div className="h-9 w-40 animate-pulse rounded-md bg-surface-inset" />
            <div className="mt-3 h-4 w-72 max-w-full animate-pulse rounded bg-surface-inset" />

            <div className="mt-8 space-y-5">
              {[0, 1].map((i) => (
                <div key={i}>
                  <div className="mb-1.5 h-3 w-24 animate-pulse rounded bg-surface-inset" />
                  <div className="h-11 w-full animate-pulse rounded-lg bg-surface-inset" />
                </div>
              ))}

              <div className="h-11 w-full animate-pulse rounded-lg bg-surface-inset" />
            </div>

            <div className="mt-8 h-px w-full bg-border" />
            <div className="mx-auto mt-6 h-4 w-56 animate-pulse rounded bg-surface-inset" />
          </div>
        </div>
      </main>
    </div>
  );
}
