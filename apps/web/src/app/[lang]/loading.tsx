import { LogoMark } from '@/components/brand/logo';

/**
 * The outermost loading state — cold entry, and the marketing page.
 *
 * This boundary sits above both route groups, so at the moment it renders there
 * is no page shape to mirror yet: it stands in for auth, the app and the
 * landing page alike. The previous file here drew a sign-in form for all three,
 * which meant opening the dashboard flashed the wrong layout before the right
 * one. That skeleton now lives in `(auth)/loading.tsx`, where it is true, and
 * `(app)` has its own.
 *
 * What is left is the one thing every route does share: the product. So this is
 * the mark, breathing, over the canvas — deliberately not a skeleton, because
 * a skeleton that guesses is a promise the next screen may not keep.
 *
 * A server component with no props: `loading.tsx` receives no params, so there
 * is no dictionary and no translatable text here. The mark carries no message
 * to translate, which is part of why it suits this position.
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="flex min-h-dvh flex-col items-center justify-center gap-7 px-6"
    >
      <div className="relative flex items-center justify-center">
        {/*
          A ring pulsing outward from behind the mark, on the existing
          `pulse-ring` token. The global reduced-motion rule collapses it, and
          the mark beneath stays legible on its own — the animation carries no
          information the static state does not.
        */}
        <span
          aria-hidden="true"
          className="bg-accent/12 animate-pulse-ring absolute size-20 rounded-2xl"
        />
        <LogoMark className="relative size-12" />
      </div>

      {/*
        A determinate-looking bar would be a lie — nothing here knows how far
        along the request is. This is a track with a highlight travelling
        through it, which says "working" without claiming progress.
      */}
      <div className="bg-surface-inset relative h-0.5 w-44 max-w-full overflow-hidden rounded-full">
        <span
          aria-hidden="true"
          className="animate-sweep bg-linear-to-r from-transparent via-accent to-transparent absolute inset-y-0 -inset-x-full motion-reduce:hidden"
        />
      </div>
    </div>
  );
}
