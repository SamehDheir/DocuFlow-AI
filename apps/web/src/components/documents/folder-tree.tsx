'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import type { Folder } from '@/lib/documents';

interface TreeNode extends Folder {
  children: TreeNode[];
  depth: number;
}

/**
 * Assembles the flat folder list the API returns into a tree.
 *
 * Built client-side because the endpoint deliberately returns one flat page —
 * folders are far fewer than documents, so one request beats a round trip per
 * expanded node.
 *
 * A folder whose parent is missing (deleted mid-session, or beyond a future
 * page) is promoted to the root rather than dropped. Silently hiding a folder
 * that still holds documents is the worse failure.
 */
function toTree(folders: Folder[]): TreeNode[] {
  const byId = new Map<string, TreeNode>(
    folders.map((folder) => [folder.id, { ...folder, children: [], depth: 0 }]),
  );
  const roots: TreeNode[] = [];

  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const assignDepth = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      node.depth = depth;
      node.children.sort((a, b) => a.name.localeCompare(b.name));
      assignDepth(node.children, depth + 1);
    }
  };

  roots.sort((a, b) => a.name.localeCompare(b.name));
  assignDepth(roots, 0);

  return roots;
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export function FolderTree({
  folders,
  selectedId,
  onSelect,
  onDelete,
  locale,
  t,
  tFolders,
}: {
  folders: Folder[];
  /** undefined means "all files"; a string selects that folder. */
  selectedId?: string;
  onSelect: (folderId?: string) => void;
  /** Omitted when the viewer lacks `folders.delete`. */
  onDelete?: (folder: Folder) => void;
  locale: Locale;
  t: Dictionary['documents'];
  tFolders: Dictionary['folders'];
}) {
  const rows = useMemo(() => flatten(toTree(folders)), [folders]);

  // Arabic renders its own digits, so the count goes through Intl rather than
  // being interpolated as a bare JS number.
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  return (
    <nav aria-label={t.folders} className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => onSelect(undefined)}
        aria-current={selectedId === undefined ? 'true' : undefined}
        className={cn(
          'rounded-md px-3 py-1.5 text-start text-sm transition-colors',
          selectedId === undefined
            ? 'bg-accent-subtle text-accent font-medium'
            : 'text-text-muted hover:bg-surface-inset hover:text-text',
        )}
      >
        {t.allFiles}
      </button>

      {rows.map((node) => (
        /*
         * A row is two controls, not one, so it cannot be a single <button> —
         * nesting one button inside another is invalid HTML and browsers
         * recover from it unpredictably. The wrapper carries the hover state
         * both children react to.
         */
        <div key={node.id} className="group relative flex items-center">
          <button
            type="button"
            onClick={() => onSelect(node.id)}
            aria-current={selectedId === node.id ? 'true' : undefined}
            /*
             * Indentation is padding-inline-start, so nesting reads correctly in
             * Arabic without a second rule. Capped at depth 4 so a deep branch
             * cannot push the label out of a narrow sidebar.
             */
            style={{ paddingInlineStart: `${0.75 + Math.min(node.depth, 4) * 0.75}rem` }}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pe-3 text-start text-sm transition-colors',
              selectedId === node.id
                ? 'bg-accent-subtle text-accent font-medium'
                : 'text-text-muted hover:bg-surface-inset hover:text-text',
            )}
            title={node.name}
          >
            <span className="truncate">{node.name}</span>

            {/*
              The digits are decorative here — the sr-only phrase beside them
              says what they count, so the button reads as "Contracts, 12
              documents" rather than "Contracts 12". Tabular figures keep the
              column steady as the tree scrolls.

              It yields to the delete button on hover rather than sitting beside
              it: a sidebar this narrow has room for one or the other, and
              reserving space for a control that is usually invisible would
              squeeze every folder name for the sake of a rare action.
            */}
            <span
              aria-hidden="true"
              className={cn(
                'ms-auto shrink-0 text-xs tabular-nums transition-opacity',
                selectedId === node.id ? 'text-accent/70' : 'text-text-subtle',
                onDelete ? 'group-hover:opacity-0 group-focus-within:opacity-0' : '',
              )}
            >
              {number.format(node.documentCount)}
            </span>

            <span className="sr-only">
              {node.documentCount === 1
                ? t.countOne
                : interpolate(t.countMany, { count: number.format(node.documentCount) })}
            </span>
          </button>

          {onDelete ? (
            /*
             * Hidden until hover, but never hidden from the keyboard:
             * `focus-visible:opacity-100` brings it back the moment it is
             * tabbed to, so the action is reachable without a pointer.
             */
            <button
              type="button"
              onClick={() => onDelete(node)}
              className={cn(
                'text-text-subtle hover:bg-danger-subtle hover:text-danger focus-visible:opacity-100',
                'absolute inset-e-1 flex size-6 shrink-0 items-center justify-center rounded-md',
                'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
              )}
            >
              <span className="sr-only">
                {interpolate(tFolders.deleteAria, { name: node.name })}
              </span>

              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                className="size-3.5"
              >
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          ) : null}
        </div>
      ))}
    </nav>
  );
}
