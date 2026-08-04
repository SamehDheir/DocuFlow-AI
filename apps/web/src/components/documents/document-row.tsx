'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { formatBytes, type DocumentSummary } from '@/lib/documents';
import { DURATION, EASE } from '@/lib/motion';

/** File-type chip. Truncated, or an extension like "spreadsheetml" bursts it. */
function FileGlyph({ extension }: { extension: string }) {
  return (
    <span
      className="border-border bg-surface-inset text-text-subtle flex size-9 shrink-0 items-center justify-center rounded-lg border text-[0.5625rem] font-medium tracking-wide uppercase"
      aria-hidden="true"
    >
      {extension.slice(0, 4)}
    </span>
  );
}

export interface RowAction {
  key: string;
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'danger';
}

/**
 * One document in the list.
 *
 * Actions sit behind a menu rather than as inline buttons. At 10,000 rows four
 * buttons each is 40,000 focusable elements, and reaching the second document
 * by keyboard would take a dozen presses.
 *
 * The prop is `item`, not `document`, so the global `document` stays reachable
 * for the outside-click listener.
 */
export function DocumentRow({
  item,
  locale,
  t,
  actions,
  onOpen,
}: {
  item: DocumentSummary;
  locale: Locale;
  t: Dictionary['documents'];
  actions: RowAction[];
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const container = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const modified = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    new Date(item.updatedAt),
  );

  return (
    <div
      ref={container}
      className="hover:bg-surface-inset/60 relative flex items-center gap-4 px-4 py-3 transition-colors"
    >
      <FileGlyph extension={item.extension} />

      <div className="min-w-0 flex-1">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="latin block max-w-full truncate text-start text-sm font-medium hover:underline"
            title={item.name}
          >
            {item.name}
          </button>
        ) : (
          <span className="latin block max-w-full truncate text-sm font-medium" title={item.name}>
            {item.name}
          </span>
        )}

        {/* Size repeats here on mobile, where its own column is hidden. */}
        <span className="text-text-subtle mt-0.5 block text-xs sm:hidden">
          {formatBytes(item.size, locale)}
        </span>
      </div>

      <span className="text-text-muted hidden w-20 shrink-0 text-end text-xs sm:block">
        {formatBytes(item.size, locale)}
      </span>

      <span className="text-text-muted hidden w-28 shrink-0 text-end text-xs md:block">
        {modified}
      </span>

      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={interpolate(t.actions.menu, { name: item.name })}
          className="text-text-subtle hover:text-text hover:bg-surface-inset flex size-8 items-center justify-center rounded-md transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="3" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="8" cy="13" r="1.4" />
          </svg>
        </button>

        {open ? (
          <motion.div
            id={menuId}
            role="menu"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: DURATION.fast, ease: EASE.outExpo }}
            className="border-border bg-surface-raised inset-e-0 absolute top-[calc(100%+0.25rem)] z-40 min-w-40 origin-top overflow-hidden rounded-lg border py-1 shadow-lg"
          >
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
                className={
                  action.tone === 'danger'
                    ? 'text-danger hover:bg-danger-subtle block w-full px-3 py-2 text-start text-sm transition-colors'
                    : 'hover:bg-surface-inset block w-full px-3 py-2 text-start text-sm transition-colors'
                }
              >
                {action.label}
              </button>
            ))}
          </motion.div>
        ) : null}
      </div>
    </div>
  );
}
