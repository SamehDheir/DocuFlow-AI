import { cn } from '@/lib/cn';

/**
 * The zero state.
 *
 * "A document system is judged on how it behaves with 0 items and with 10,000"
 * — so this is a designed screen, not a shrug. It carries an illustration, a
 * heading that says what is true, a line that says what to do about it, and the
 * action itself, because an empty list with no way forward is a dead end.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'border-border bg-surface flex flex-col items-center rounded-xl border px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? <div className="text-text-subtle mb-5">{icon}</div> : null}

      <h2 className="font-display text-xl">{title}</h2>
      <p className="text-text-muted mt-2 max-w-sm text-sm text-balance">{body}</p>

      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

/** Line-art folder, sized to sit above an EmptyState heading. */
export function FolderGlyph() {
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 56 56"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
    >
      <path
        d="M6 16a4 4 0 0 1 4-4h10.7a4 4 0 0 1 3.1 1.5l2.4 3H46a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4Z"
        strokeLinejoin="round"
      />
      <path d="M6 24h44" opacity="0.5" />
    </svg>
  );
}

/** Line-art page, for document-shaped empties. */
export function DocumentGlyph() {
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 56 56"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
    >
      <path
        d="M14 7h19l9 9v33a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V10a3 3 0 0 1 3-3Z"
        strokeLinejoin="round"
      />
      <path d="M33 7v9h9" strokeLinejoin="round" />
      <path d="M18 30h20M18 38h14" opacity="0.5" strokeLinecap="round" />
    </svg>
  );
}
