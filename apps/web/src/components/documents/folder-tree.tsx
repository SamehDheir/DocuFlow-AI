'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import type { Dictionary } from '@/i18n/get-dictionary';
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
  t,
}: {
  folders: Folder[];
  /** undefined means "all files"; a string selects that folder. */
  selectedId?: string;
  onSelect: (folderId?: string) => void;
  t: Dictionary['documents'];
}) {
  const rows = useMemo(() => flatten(toTree(folders)), [folders]);

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
        <button
          key={node.id}
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
            'truncate rounded-md py-1.5 pe-3 text-start text-sm transition-colors',
            selectedId === node.id
              ? 'bg-accent-subtle text-accent font-medium'
              : 'text-text-muted hover:bg-surface-inset hover:text-text',
          )}
          title={node.name}
        >
          {node.name}
        </button>
      ))}
    </nav>
  );
}
