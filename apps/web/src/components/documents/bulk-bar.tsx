'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button } from '@/components/ui/button';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { cn } from '@/lib/cn';
import type { BulkResult } from '@/lib/documents';
import { codeMessage } from '@/lib/error-message';
import { DURATION, EASE } from '@/lib/motion';

export interface BulkAction {
  key: string;
  label: string;
  tone?: 'default' | 'danger';
  onSelect: () => void;
}

/** What the last batch did, and which action it was, so the summary can name it. */
export interface BulkOutcome {
  action: string;
  result: BulkResult;
}

/**
 * The action bar for a multi-select.
 *
 * STICKY AT THE BOTTOM, not a toolbar above the list. The selection is made by
 * working down the page, so by the time there is something to act on the top of
 * the list is usually scrolled away — a bar up there would be a control the user
 * has to go back for. It sits above the content rather than over it, and the
 * list carries matching bottom padding so the last row is never underneath it.
 *
 * PARTIAL SUCCESS GETS A PANEL, not a toast. The API returns 200 with a per-id
 * report either way, and "43 archived, 7 skipped" is a result the reader has to
 * be able to sit and read: which reasons, how many of each. A toast that fades
 * after four seconds is the wrong shape for it, and dropping the detail to fit
 * one line is how a user ends up believing all fifty went through.
 */
export function BulkBar({
  count,
  actions,
  busy,
  outcome,
  onDismiss,
  onClear,
  t,
  errors,
  common,
  className,
}: {
  count: number;
  actions: BulkAction[];
  /** The key of the action currently running, if any. */
  busy?: string | null;
  outcome: BulkOutcome | null;
  onDismiss: () => void;
  onClear: () => void;
  t: Dictionary['bulk'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  className?: string;
}) {
  const reduced = useReducedMotion();

  /**
   * The bar outlives the selection.
   *
   * A batch clears what it acted on — the rows are in the trash, or archived out
   * of the default listing — so gating the whole bar on `count > 0` would take
   * the report away in the same frame it arrived. The count and the buttons go;
   * the outcome stays until it is dismissed.
   */
  const open = count > 0 || outcome !== null;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
          transition={{ duration: DURATION.base, ease: EASE.outQuint }}
          className={cn('sticky bottom-4 z-20 mt-4', className)}
        >
          <div className="border-border bg-surface-raised rounded-xl border shadow-lg">
            {/*
              Removed, not hidden, once the selection is gone. A `display:none`
              row would leave "0 selected" sitting in an aria-live region, which
              is announced the moment it changes and is not a sentence anyone
              needs to hear.
            */}
            {count > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                {/*
                  Announced, because the count changes as rows are ticked and a
                  screen-reader user otherwise has to re-read the page to learn
                  what a "Delete" button is about to act on.
                */}
                <p aria-live="polite" className="text-sm font-medium tabular-nums">
                  {count === 1 ? t.selectedOne : interpolate(t.selectedMany, { count })}
                </p>

                <Button variant="ghost" size="sm" onClick={onClear}>
                  {t.clear}
                </Button>

                <span className="flex-1" />

                {actions.map((action) => (
                  <Button
                    key={action.key}
                    size="sm"
                    variant="secondary"
                    // Tinted from the token layer rather than a new Button
                    // variant: `Menu` already spells danger this way, and one
                    // destructive button in a bar does not justify a fourth
                    // variant every other call site then has to reason about.
                    className={cn(
                      action.tone === 'danger' &&
                        'text-danger border-danger-border hover:bg-danger-subtle hover:border-danger',
                    )}
                    loading={busy === action.key}
                    // One at a time: two batches over one selection would report
                    // two outcomes into the same panel and race over the rows.
                    disabled={!!busy && busy !== action.key}
                    onClick={action.onSelect}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : null}

            <AnimatePresence>
              {outcome ? (
                <motion.div
                  initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: DURATION.base, ease: EASE.outQuint }}
                  className="overflow-hidden"
                >
                  <BulkSummary
                    outcome={outcome}
                    standalone={count === 0}
                    onDismiss={onDismiss}
                    t={t}
                    errors={errors}
                    common={common}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * The per-id report, grouped.
 *
 * Grouped by reason rather than listed by id: fifty ids is a wall of UUIDs the
 * reader cannot map to anything, whereas "7 already archived" is the whole
 * answer. The ids are still in the result if a caller ever needs them.
 */
function BulkSummary({
  outcome,
  standalone,
  onDismiss,
  t,
  errors,
  common,
}: {
  outcome: BulkOutcome;
  /** True once the selection has been cleared and the panel is all that is left. */
  standalone: boolean;
  onDismiss: () => void;
  t: Dictionary['bulk'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
}) {
  const { result } = outcome;
  const done = result.succeeded.length;

  const reasons = new Map<string, number>();

  for (const skip of result.skipped) {
    reasons.set(skip.code, (reasons.get(skip.code) ?? 0) + 1);
  }

  const clean = result.skipped.length === 0;

  return (
    <div
      // `status` rather than `alert`: a partial result is information, and an
      // assertive interruption for "7 of 50 were already archived" would talk
      // over whatever the reader was doing.
      role="status"
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3',
        // The rule only exists when there is an actions row above to separate
        // from; on its own the panel IS the bar and needs the full radius.
        standalone ? 'rounded-xl' : 'border-border border-t',
        clean ? 'bg-success-subtle' : 'bg-warning-subtle',
      )}
    >
      <div className="min-w-0">
        <p className={cn('text-sm font-medium', clean ? 'text-success' : 'text-warning')}>
          {interpolate(clean ? t.allDone : t.partial, {
            done,
            skipped: result.skipped.length,
            total: result.requested,
          })}
        </p>

        {reasons.size > 0 ? (
          <ul className="text-text-muted mt-1.5 flex flex-col gap-0.5 text-xs">
            {[...reasons].map(([code, times]) => (
              <li key={code}>
                <span className="tabular-nums">{times}</span>{' '}
                {codeMessage(code, errors, common.genericError)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {common.close}
      </Button>
    </div>
  );
}
