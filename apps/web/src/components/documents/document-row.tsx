'use client';

import Link from 'next/link';
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
import { cn } from '@/lib/cn';
import { formatBytes, type DocumentSummary, type DocumentTag } from '@/lib/documents';
import { DocumentStatusBadge } from './document-status';
import { TagChips } from './document-tags';

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
  href,
  onOpen,
  select,
  star,
  selected = false,
  onTagSelect,
}: {
  item: DocumentSummary;
  locale: Locale;
  t: Dictionary['documents'];
  actions: RowAction[];
  /** Destination for the name. Takes precedence over `onOpen`. */
  href?: string;
  onOpen?: () => void;
  /**
   * Slots rather than props, so the row stays free of the session, the toast and
   * the selection model while both controls keep a fixed position in the layout.
   * A row that renders its own checkbox in one view and not another is how two
   * lists end up with different column rhythms.
   */
  select?: React.ReactNode;
  star?: React.ReactNode;
  /** Only for the tint and `aria-selected`; the checkbox inside `select` owns the state. */
  selected?: boolean;
  /** Makes the tag chips filter controls. Omitted, they are plain labels. */
  onTagSelect?: (tag: DocumentTag) => void;
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
      className={cn(
        'relative flex items-center gap-4 px-4 py-3 transition-colors',
        // The tint is what makes a selection legible while scrolling past the
        // header checkbox; a tick 40 rows up is not a state anyone can hold.
        selected ? 'bg-accent-subtle/60' : 'hover:bg-surface-inset/60',
      )}
    >
      {select ? <div className="shrink-0">{select}</div> : null}

      <FileGlyph extension={item.extension} />

      <div className="min-w-0 flex-1">
        {href ? (
          /*
           * The name leads to the detail route, not the quick-look dialog.
           *
           * The dialog is still one click away in the menu, and it is the right
           * shape for "is this the file I meant". But the aggregate — history,
           * discussion, the trail — is what the product is for, and burying it
           * behind a menu makes the browser feel like the whole application.
           * A real <a> also means middle-click and "open in new tab" work.
           */
          <Link
            href={href}
            className="latin focus-visible:outline-focus block max-w-full truncate rounded-xs text-start text-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            title={item.name}
          >
            {item.name}
          </Link>
        ) : onOpen ? (
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

        {/*
          Under the name, capped at three. Tags are what `?tagId=` filters on,
          so a browser that never shows them leaves the filter undiscoverable —
          but a row is one line tall, and an unbounded set would push the name
          out of the layout that makes the list scannable in the first place.
        */}
        {item.tags && item.tags.length > 0 ? (
          <TagChips tags={item.tags} max={3} onSelect={onTagSelect} className="mt-1" />
        ) : null}
      </div>

      {star ? <div className="shrink-0">{star}</div> : null}

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
