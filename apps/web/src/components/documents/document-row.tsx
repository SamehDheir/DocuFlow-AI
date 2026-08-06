'use client';

import { useId, useRef, useState } from 'react';
import {
  Menu,
  originFromContextMenu,
  type MenuAction,
  type MenuOrigin,
} from '@/components/ui/menu';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { formatBytes, type DocumentSummary } from '@/lib/documents';
import { DocumentStatusBadge } from './document-status';

/** File-type chip. Truncated, or an extension like "spreadsheetml" bursts it. */
function FileGlyph({ extension }: { extension: string }) {
  return (
    <span
      className="border-border bg-surface-inset text-text-subtle text-3xs flex size-9 shrink-0 items-center justify-center rounded-lg border font-medium tracking-wide uppercase"
      aria-hidden="true"
    >
      {extension.slice(0, 4)}
    </span>
  );
}

export type RowAction = MenuAction;

/**
 * One document in the list.
 *
 * Actions sit behind a menu rather than as inline buttons. At 10,000 rows four
 * buttons each is 40,000 focusable elements, and reaching the second document
 * by keyboard would take a dozen presses.
 *
 * That menu opens two ways: the kebab, which every pointer and every keyboard
 * can reach, and a right-click anywhere on the row, which is what anyone who
 * has used a file manager will try first. The kebab is the accessible path and
 * stays; the context menu is an accelerator layered over it, not a replacement.
 *
 * The prop is `item`, not `document`, so the global `document` stays reachable
 * for the outside-click listener inside Menu.
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
  const [origin, setOrigin] = useState<MenuOrigin | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const menuLabel = interpolate(t.actions.menu, { name: item.name });

  return (
    <div
      onContextMenu={(event) => {
        const next = originFromContextMenu(event, trigger.current);
        if (!next) return;

        // Only once we know we can offer something better than the browser's
        // own menu.
        event.preventDefault();
        setOrigin(next);
      }}
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

      {/*
       * Renders nothing for a READY document whose processing succeeded — which
       * is nearly every row. A badge on all of them would be noise that hides
       * the few actually in flight rather than surfacing them.
       */}
      <DocumentStatusBadge
        status={item.status}
        ocrStatus={item.metadata?.ocrStatus}
        aiStatus={item.metadata?.aiStatus}
        t={t}
        className="hidden shrink-0 sm:inline-flex"
      />

      <span className="text-text-muted hidden w-20 shrink-0 text-end text-xs sm:block">
        {formatBytes(item.size, locale)}
      </span>

      <span className="text-text-muted hidden w-28 shrink-0 text-end text-xs md:block">
        {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(item.updatedAt))}
      </span>

      <div className="shrink-0">
        <button
          ref={trigger}
          type="button"
          onClick={() =>
            setOrigin((current) =>
              current ? null : trigger.current ? { kind: 'element', el: trigger.current } : null,
            )
          }
          aria-haspopup="menu"
          aria-expanded={origin !== null}
          aria-controls={origin ? menuId : undefined}
          aria-label={menuLabel}
          className="text-text-subtle hover:text-text hover:bg-surface-inset flex size-8 items-center justify-center rounded-md transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="3" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="8" cy="13" r="1.4" />
          </svg>
        </button>
      </div>

      <Menu
        id={menuId}
        origin={origin}
        onClose={() => setOrigin(null)}
        actions={actions}
        label={menuLabel}
      />
    </div>
  );
}
