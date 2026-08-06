'use client';

import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { relativeTime, type ActivityEntry } from '@/lib/activity';

type ActivityStrings = Dictionary['activity'];

/**
 * The subject an entry acted on.
 *
 * Audit metadata is deliberately loose — it is a JSON column, and each action
 * writes what is useful for that action. A rename records `from`/`to`, most
 * others record `name`. Anything unrecognised simply has no subject rather than
 * rendering "[object Object]".
 */
function subjectOf(entry: ActivityEntry): string | null {
  const meta = entry.metadata;
  if (!meta) return null;

  for (const key of ['name', 'to'] as const) {
    const value = meta[key];
    if (typeof value === 'string' && value) return value;
  }

  return null;
}

function initialsOf(entry: ActivityEntry, fallback: string): string {
  if (!entry.user) return fallback.slice(0, 1).toUpperCase();

  const { firstName, lastName } = entry.user;
  return `${firstName.slice(0, 1)}${lastName.slice(0, 1)}`.toUpperCase();
}

/**
 * One line of the trail.
 *
 * Reads as a sentence — who, what, which file — because "who changed or deleted
 * this" is the question the product exists to answer, and a table of enum codes
 * answers it slower than prose does.
 */
export function ActivityRow({
  entry,
  locale,
  t,
}: {
  entry: ActivityEntry;
  locale: Locale;
  t: ActivityStrings;
}) {
  const actor = entry.user ? `${entry.user.firstName} ${entry.user.lastName}` : t.system;
  // Falls back to the raw action so a v2 action added before its translation
  // still reads as something rather than as undefined.
  const verb = t.actions[entry.action as keyof typeof t.actions] ?? entry.action;
  const subject = subjectOf(entry);

  const absolute = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(entry.createdAt));

  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span
        aria-hidden="true"
        className="bg-surface-inset text-text-subtle border-border text-3xs mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border font-semibold"
      >
        {initialsOf(entry, t.system)}
      </span>

      <p className="min-w-0 flex-1 text-sm leading-relaxed">
        <span className="font-medium">{actor}</span> <span className="text-text-muted">{verb}</span>
        {subject ? (
          <>
            {' — '}
            {/* Filenames are frequently Latin inside Arabic copy, so they are
                isolated to stop the bidi algorithm reordering them. */}
            <span className="latin break-all" title={subject}>
              {subject}
            </span>
          </>
        ) : null}
      </p>

      <time
        dateTime={entry.createdAt}
        title={absolute}
        className="text-text-subtle mt-0.5 shrink-0 text-xs whitespace-nowrap"
      >
        {relativeTime(entry.createdAt, locale)}
      </time>
    </li>
  );
}
