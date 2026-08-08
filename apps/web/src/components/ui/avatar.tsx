import { cn } from '@/lib/cn';

/**
 * Initials in a circle.
 *
 * Three copies of this had accumulated — the account menu, the members list and
 * the activity feed — and only one of them was correct. The other two sliced
 * with `charAt(0)` / `slice(0, 1)`, which takes half a surrogate pair and
 * renders a name starting with an astral character as a replacement glyph.
 *
 * `codePointAt` is what fixes that, and taking the first code point of EACH name
 * rather than a fixed count is what makes it work for Arabic as well as Latin —
 * the product ships in both.
 */
export function initialsOf(first?: string | null, last?: string | null, fallback = '?'): string {
  const take = (value?: string | null) => {
    const trimmed = value?.trim() ?? '';
    const code = trimmed.codePointAt(0);

    return code === undefined ? '' : String.fromCodePoint(code);
  };

  return `${take(first)}${take(last)}`.toLocaleUpperCase() || take(fallback) || '?';
}

type Size = 'sm' | 'md' | 'lg';
type Tone = 'neutral' | 'accent';

const SIZES: Record<Size, string> = {
  sm: 'size-8 text-3xs',
  md: 'size-9 text-3xs',
  lg: 'size-11 text-2xs',
};

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-inset text-text-subtle border-border',
  accent: 'bg-accent-subtle text-accent border-accent-border',
};

/**
 * `aria-hidden` by default, and that is deliberate rather than an oversight:
 * every call site renders the person's actual name beside it, so announcing the
 * initials too would read the same person twice. Pass `label` for the one case
 * where the avatar stands alone — the account button in the header.
 */
export function Avatar({
  firstName,
  lastName,
  fallback,
  label,
  size = 'md',
  tone = 'neutral',
  className,
}: {
  firstName?: string | null;
  lastName?: string | null;
  /** Shown when there is no name at all — a system actor, say. */
  fallback?: string;
  /** Accessible name. Omit when the name is already rendered next to it. */
  label?: string;
  size?: Size;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border font-semibold select-none',
        SIZES[size],
        TONES[tone],
        className,
      )}
    >
      {initialsOf(firstName, lastName, fallback)}
    </span>
  );
}
