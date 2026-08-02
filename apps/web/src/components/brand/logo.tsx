import { cn } from '@/lib/cn';

/**
 * DocuFlow mark.
 *
 * Two offset sheets with a channel cut through them — the "flow" of the name,
 * and a shape that stays legible at 20px in a sidebar. Drawn rather than
 * pulled from an icon set so the product has an actual identity of its own.
 *
 * The back sheet uses the accent at low opacity so the mark reads as one object
 * in both themes instead of two competing silhouettes.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={cn('h-8 w-8', className)}>
      {/* Back sheet, offset up-right */}
      <path
        d="M12.5 3.5h9.2L27 8.8v13.4a2.6 2.6 0 0 1-2.6 2.6H12.5a2.6 2.6 0 0 1-2.6-2.6V6.1a2.6 2.6 0 0 1 2.6-2.6Z"
        className="fill-accent/22"
      />
      {/* Front sheet */}
      <path
        d="M7.6 7.4h9.2l5.3 5.3v13.4a2.6 2.6 0 0 1-2.6 2.6H7.6A2.6 2.6 0 0 1 5 26.1V10a2.6 2.6 0 0 1 2.6-2.6Z"
        className="fill-accent"
      />
      {/* Folded corner — reads as paper, not a generic rounded rect */}
      <path d="M16.8 7.4l5.3 5.3h-5.3V7.4Z" className="fill-accent-fg/45" />
      {/* Flow channel */}
      <path
        d="M9.4 15.2h8.4M9.4 19h6M9.4 22.8h3.6"
        stroke="currentColor"
        className="text-accent-fg"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity="0.9"
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
        <span className="font-display text-lg leading-none font-semibold tracking-tight">
          Docu<span className="text-accent">Flow</span>
        </span>
      )}
    </span>
  );
}
