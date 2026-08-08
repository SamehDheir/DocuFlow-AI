import { cn } from '@/lib/cn';

/**
 * The surface every panel in the app sits on.
 *
 * `border-border bg-surface rounded-xl border` had accumulated across roughly
 * two dozen call sites with four different paddings between them, which is how
 * a "consistent visual identity" quietly stops being one. Elevation, radius and
 * rhythm are decided here instead.
 *
 * `tone="sunken"` is for a panel that recedes — a nested list inside another
 * card, or a preview well. `interactive` adds the lift and border change a
 * clickable card needs; it does NOT make the card focusable, because the
 * focusable thing should be the link or button inside it.
 */
type Tone = 'default' | 'sunken' | 'raised';
type Padding = 'none' | 'sm' | 'md' | 'lg';

const TONES: Record<Tone, string> = {
  default: 'bg-surface border-border',
  sunken: 'bg-surface-inset border-border',
  raised: 'bg-surface-raised border-border shadow-sm',
};

const PADDING: Record<Padding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6 sm:p-7',
};

export function Card({
  tone = 'default',
  padding = 'md',
  interactive = false,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  tone?: Tone;
  padding?: Padding;
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border',
        TONES[tone],
        PADDING[padding],
        interactive &&
          cn(
            'transition-[border-color,box-shadow,transform] duration-fast ease-out-quint',
            'hover:border-border-strong hover:shadow-md',
            // Movement is skipped for anyone who has asked for less of it. The
            // border and shadow still change, so the card is still obviously
            // live.
            'motion-safe:hover:-translate-y-0.5',
            // Focus inside the card is drawn around the whole card, so a
            // keyboard user sees the same target a mouse user clicks.
            'has-[:focus-visible]:border-accent has-[:focus-visible]:shadow-md',
          ),
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * A card's title row, with the rule under it.
 *
 * Separate from Card rather than props on it, so a card can carry a header, a
 * toolbar, or nothing at all without Card growing a branch per layout.
 */
export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** End-aligned control — a filter, a "see all" link. */
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'border-border flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b pb-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="font-display text-base">{title}</h2>
        {description ? <p className="text-text-muted mt-1 text-xs">{description}</p> : null}
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
