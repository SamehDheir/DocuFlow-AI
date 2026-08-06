import { apiGet, query } from './api';

/**
 * The audit trail, read side.
 *
 * Every entry the API returns is already scoped to the reader's company by the
 * tenant guard, and the route sits behind `audit.read` — which Member does not
 * hold, so a caller must check the permission before rendering anything that
 * depends on this.
 */

export interface ActivityActor {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ActivityEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  /** null for system-initiated actions — a queue worker has no user. */
  user: ActivityActor | null;
}

export interface ActivityPage {
  items: ActivityEntry[];
  nextCursor: string | null;
}

export interface ActivityOptions {
  cursor?: string;
  limit?: number;
  action?: string;
  entityType?: string;
  userId?: string;
}

export function listActivity(token: string, options: ActivityOptions = {}): Promise<ActivityPage> {
  return apiGet<ActivityPage>(
    `/audit${query({
      cursor: options.cursor,
      limit: options.limit,
      action: options.action || undefined,
      entityType: options.entityType || undefined,
      userId: options.userId || undefined,
    })}`,
    token,
  );
}

/** The distinct actions this company has recorded, for the filter control. */
export function listActivityActions(token: string): Promise<string[]> {
  return apiGet<string[]>('/audit/actions', token);
}

/**
 * A relative timestamp — "3 hours ago" — in the reader's locale.
 *
 * Intl.RelativeTimeFormat rather than a date: a trail is read to answer "what
 * just happened", and "2 minutes ago" answers it faster than a wall clock time
 * the reader has to subtract from. The absolute value stays available in the
 * <time> element's dateTime attribute and its tooltip.
 */
export function relativeTime(iso: string, locale: string): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const seconds = (Date.parse(iso) - Date.now()) / 1000;

  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Infinity],
  ];

  let value = seconds;

  for (const [unit, span] of steps) {
    if (Math.abs(value) < span) return formatter.format(Math.round(value), unit);
    value /= span;
  }

  return formatter.format(Math.round(value), 'year');
}
