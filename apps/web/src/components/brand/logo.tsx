import { cn } from '@/lib/cn';

/**
 * DocuFlow mark.
 *
 * Same geometry as the site icon (app/icon.svg and app/apple-icon.tsx): a sheet
 * with a folded corner whose lines shorten as they descend — content moving
 * through a pipeline. One shape everywhere, so the browser tab, the home-screen
 * icon and the in-app header are recognisably the same product.
 *
 * The earlier two-sheet mark is gone: it read as two competing silhouettes at
 * small sizes and no longer matched the favicon.
 *
 * COLOUR: driven by tokens rather than the icon's baked-in hex, because this
 * one renders inside the app and has to work in both themes. In light, a copper
 * tile carries a near-white sheet; in dark, both invert with the accent so the
 * mark keeps its contrast instead of turning into a dark square on a dark
 * surface. The tile is what makes it legible on the light header AND on the
 * dark brand panel without a second variant.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={cn('h-8 w-8', className)}>
      {/* Copper field */}
      <rect width="32" height="32" rx="7.4" className="fill-accent" />
      {/* Sheet */}
      <path
        d="M9.2 5.5h7.6l6.7 6.7v13.3a2 2 0 0 1-2 2H9.2a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2Z"
        className="fill-accent-fg"
      />
      {/* Folded corner. Reduced opacity over the copper field blends to the same
          tan as the icon's baked-in fold, without needing a third token. */}
      <path d="M16.8 5.5l6.7 6.7h-4.7a2 2 0 0 1-2-2V5.5Z" className="fill-accent-fg/55" />
      {/* Flow: lines shorten as they descend */}
      <path
        d="M10.9 16.5h9.4M10.9 20.1h6.9M10.9 23.7h4.2"
        className="stroke-accent"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo({
  className,
  markClassName,
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className={markClassName} />
      {showWordmark && (
        // `latin` keeps the wordmark in the Latin face inside Arabic pages —
        // the brand name is not translated, so it should not be rendered in the
        // Arabic font's Latin subset.
        <span className="latin font-display text-lg leading-none font-semibold tracking-tight">
          Docu<span className="text-accent">Flow</span>
        </span>
      )}
    </span>
  );
}
