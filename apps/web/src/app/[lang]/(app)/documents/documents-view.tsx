'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { fetchProfile } from '@/lib/auth';
import { useLiveEvent } from '@/components/providers/live-provider';
import { BulkBar, type BulkAction, type BulkOutcome } from '@/components/documents/bulk-bar';
import { DocumentPreview } from '@/components/documents/document-preview';
import { FavoriteStar } from '@/components/documents/favorite-star';
import { RequestApprovalDialog } from '@/components/documents/request-approval-dialog';
import { DocumentRow, type RowAction } from '@/components/documents/document-row';
import { DropZone } from '@/components/documents/drop-zone';
import { FolderTree } from '@/components/documents/folder-tree';
import { UploadQueue } from '@/components/documents/upload-queue';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { PageHeader } from '@/components/ui/page-header';
import { Dialog } from '@/components/ui/dialog';
import { Drawer } from '@/components/ui/drawer';
import { DocumentGlyph, EmptyState, FolderGlyph } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/select';
import { SkeletonRegion, SkeletonRows } from '@/components/ui/skeleton';
import { TagInput } from '@/components/ui/tag-input';
import { TextField } from '@/components/ui/text-field';
import { useToast } from '@/components/ui/toast';
import { direction, type Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { cn } from '@/lib/cn';
import {
  bulkArchive,
  bulkDelete,
  bulkMove,
  bulkSetTags,
  bulkUnarchive,
  createFolder,
  deleteFolder,
  deleteDocument,
  isProcessing,
  listDocuments,
  listFolders,
  reprocessDocument,
  MAX_BULK_IDS,
  type BulkResult,
  type DocumentSummary,
  type Folder,
} from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { respectMotion, riseItem, stagger } from '@/lib/motion';
import { listTags, type TagListItem } from '@/lib/tags';
import { useDocumentDownload } from '@/lib/use-download';

type Load = 'loading' | 'ready' | 'error';

/** Debounce for the search box — one request per keystroke would be absurd. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * One frozen array for "nothing selected".
 *
 * A fresh `[]` per render would be a new identity every time, which defeats
 * every memo downstream of the selection for a value that never changes.
 */
const EMPTY_SELECTION: readonly string[] = Object.freeze([]);

export function DocumentsView({
  lang,
  t,
  tUpload,
  tFolders,
  tConfirm,
  tApprovals,
  tTags,
  tBulk,
  errors,
  common,
}: {
  lang: Locale;
  t: Dictionary['documents'];
  tUpload: Dictionary['upload'];
  tFolders: Dictionary['folders'];
  tConfirm: Dictionary['confirm'];
  tApprovals: Dictionary['approvals'];
  tTags: Dictionary['tags'];
  tBulk: Dictionary['bulk'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
}) {
  const { status, withToken } = useSession();
  const toast = useToast();
  const reduced = useReducedMotion();
  const searchParams = useSearchParams();

  /**
   * Read from `/auth/me`, not from the session.
   *
   * The access token carries roles, not permissions — they are resolved per
   * request so that revoking one bites sooner than the 15-minute token life.
   * Fetched once on sign-in rather than inside `refresh`, which re-runs on every
   * folder change and keystroke.
   */
  const [permissions, setPermissions] = useState<string[]>([]);
  const canDeleteFolders = permissions.includes('folders.delete');
  const canUpdate = permissions.includes('documents.update');
  const canDelete = permissions.includes('documents.delete');
  const canReadTags = permissions.includes('tags.read');
  const canCreateTags = permissions.includes('tags.manage');

  const [load, setLoad] = useState<Load>('loading');
  const [message, setMessage] = useState('');
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [vocabulary, setVocabulary] = useState<TagListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * Seeded from `?folderId=`, which the detail page's breadcrumb has been
   * linking to since v4 with nothing here reading it — so "back to the folder
   * this document is in" landed on the unfiltered list.
   *
   * The initial value only. After arrival the tree owns the selection, and a URL
   * that kept overriding it would undo every click.
   */
  const [folderId, setFolderId] = useState<string | undefined>(
    () => searchParams.get('folderId') ?? undefined,
  );
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  /**
   * The three v4 filters. All three compose with the folder and the search box —
   * which is why `?favorite=true` is a parameter on the documents endpoint
   * rather than a `/favorites` collection that would need its own copy of each.
   */
  const [favorite, setFavorite] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [tagId, setTagId] = useState<string | undefined>(undefined);

  /**
   * The multi-select, stamped with the filter it was made under.
   *
   * A selection is only meaningful against the rows it was made on: changing
   * folder or filter replaces the list underneath it, so ticks made before the
   * change would act on documents no longer on screen. Rather than clearing it
   * from an effect — a cascading render, and what `react-hooks/set-state-in-effect`
   * exists to catch — the stamp is compared during render and a stale selection
   * simply reads as empty. `filters` is a memo, so its identity changes exactly
   * when a filter does; appending a page with "load more" does not disturb it,
   * because those rows are still there.
   *
   * Held as an ordered array rather than a Set: the order is the order things
   * were ticked, which is the order the batch is sent in.
   */
  const [selection, setSelection] = useState<{ under: unknown; ids: string[] }>({
    under: null,
    ids: [],
  });
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [tagging, setTagging] = useState(false);
  const [tagAdd, setTagAdd] = useState<string[]>([]);
  const [tagRemove, setTagRemove] = useState<string[]>([]);

  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<DocumentSummary | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);
  const [previewing, setPreviewing] = useState<DocumentSummary | null>(null);
  const [requestingApproval, setRequestingApproval] = useState<DocumentSummary | null>(null);
  /** The tablet folder picker — see the trigger beside the toolbar below. */
  const [browsingFolders, setBrowsingFolders] = useState(false);

  /**
   * Patches rows in place as the worker moves each document through the
   * pipeline. Only the fields the event carries are touched, so a row updated
   * mid-scroll keeps everything else it already had — and no refetch is issued,
   * which would reorder the list under the user.
   */
  useLiveEvent((event) => {
    if (event.type !== 'document.status') {
      return;
    }

    setDocuments((current) =>
      current.map((row) =>
        row.id === event.documentId
          ? {
              ...row,
              status: event.status,
              metadata: {
                ocrStatus: event.ocrStatus,
                aiStatus: event.aiStatus,
                ocrPages: row.metadata?.ocrPages ?? null,
              },
            }
          : row,
      ),
    );
  });

  const filePicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  /**
   * Separate from the document load so it runs once, and settles independently:
   * a failed profile read must not blank the documents beside it. The gated
   * controls simply stay hidden, and the API refuses anything reached without
   * the permission regardless — this only stops the UI offering a button that
   * is guaranteed to 403.
   */
  useEffect(() => {
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        const profile = await withToken(fetchProfile);
        if (current) setPermissions(profile.permissions);
      } catch {
        if (current) setPermissions([]);
      }
    })();

    return () => {
      current = false;
    };
  }, [status, withToken]);

  /** Everything that narrows the list, in one place so no call site can forget one. */
  const filters = useMemo(
    () => ({ folderId, q: debounced, favorite, includeArchived, tagId }),
    [folderId, debounced, favorite, includeArchived, tagId],
  );

  const filtered = favorite || includeArchived || !!tagId;

  /**
   * Bumped to refetch after a batch, without disturbing the filters.
   *
   * A bulk action changes rows the current page is showing — deleted ones leave,
   * archived ones leave the default listing, retagged ones show different chips
   * — and patching all six outcomes locally would be six copies of rules the API
   * already applied.
   */
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        const [page, tree] = await Promise.all([
          withToken((token) => listDocuments(token, filters)),
          withToken(listFolders),
        ]);

        // A stale response must not overwrite a newer one — the filter may have
        // changed twice while the first request was in flight.
        if (!current) return;

        setDocuments(page.items);
        setCursor(page.nextCursor);
        setFolders(tree);
        setLoad('ready');
      } catch (error) {
        if (!current) return;
        setMessage(errorMessage(error, errors, common.genericError));
        setLoad('error');
      }
    })();

    return () => {
      current = false;
    };
  }, [status, withToken, filters, errors, common.genericError, reloadKey]);

  /**
   * The tag vocabulary, fetched once and separately.
   *
   * Separate so a Member without `tags.read` — or a 403 from it — leaves the
   * documents beside it untouched: the filter and the picker simply do not
   * appear, and every route behind them would 403 anyway.
   */
  useEffect(() => {
    if (status !== 'authenticated' || !canReadTags) return;

    let current = true;

    void (async () => {
      try {
        const all = await withToken(listTags);
        if (current) setVocabulary(all);
      } catch {
        if (current) setVocabulary([]);
      }
    })();

    return () => {
      current = false;
    };
  }, [status, withToken, canReadTags]);

  const selected = selection.under === filters ? selection.ids : EMPTY_SELECTION;
  const setSelected = (ids: string[]) => setSelection({ under: filters, ids });

  const loadMore = async () => {
    if (!cursor || loadingMore) return;

    setLoadingMore(true);

    try {
      const page = await withToken((token) => listDocuments(token, { ...filters, cursor }));
      setDocuments((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setLoadingMore(false);
    }
  };

  const download = useDocumentDownload(errors, common);

  const allSelected = documents.length > 0 && selected.length === documents.length;

  const toggleRow = (id: string, next: boolean) =>
    setSelected(next ? [...selected, id] : selected.filter((entry) => entry !== id));

  /**
   * "Select all" means all LOADED rows, not everything matching the filter.
   *
   * The API takes a list of ids, so there is nothing to send for rows the client
   * has never seen — and `MAX_BULK_IDS` is 200 against a page of 50, so a reader
   * who has pressed "load more" four times can still act on the lot. Selecting
   * ten thousand documents would need the endpoint to accept a filter instead;
   * see NEXT_STEPS.md.
   */
  const toggleAll = (next: boolean) =>
    setSelected(next ? documents.slice(0, MAX_BULK_IDS).map((item) => item.id) : []);

  /**
   * Runs one batch and reports it.
   *
   * The list is refetched rather than patched: six actions each changing which
   * rows still belong on screen is six chances to re-derive a rule the API has
   * already applied. The selection is cleared because the rows it named have
   * moved — the outcome panel survives it, which is why BulkBar does not hide
   * when the count reaches zero.
   */
  const runBulk = async (key: string, run: (ids: string[]) => Promise<BulkResult>) => {
    if (selected.length === 0 || bulkBusy) return;

    setBulkBusy(key);
    setOutcome(null);

    try {
      // Copied, because the frozen empty-selection constant is readonly and the
      // request serialises the array either way.
      const result = await run([...selected]);

      setOutcome({ action: key, result });
      setSelected([]);
      refresh();
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setBulkBusy(null);
    }
  };

  /**
   * No checkboxes at all when nothing can be done with a selection.
   *
   * A reader who holds neither `documents.update` nor `documents.delete` would
   * be offered a column of ticks and then a bar with no buttons in it.
   */
  const selectable = canUpdate || canDelete;

  const bulkActions: BulkAction[] = [
    ...(canUpdate && canReadTags
      ? [{ key: 'tag', label: tBulk.tag, onSelect: () => setTagging(true) }]
      : []),
    ...(canUpdate
      ? [
          { key: 'move', label: tBulk.move, onSelect: () => setMoving(true) },
          {
            key: 'archive',
            label: tBulk.archive,
            onSelect: () =>
              void runBulk('archive', (ids) => withToken((token) => bulkArchive(token, ids))),
          },
          /**
           * Offered alongside archive rather than instead of it. A selection can
           * hold both kinds, and the API reports the ones an action does not
           * apply to as skipped — so guessing which button to show from the
           * current filter would be a guess that is sometimes wrong.
           */
          {
            key: 'unarchive',
            label: tBulk.unarchive,
            onSelect: () =>
              void runBulk('unarchive', (ids) => withToken((token) => bulkUnarchive(token, ids))),
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            key: 'delete',
            label: tBulk.delete,
            tone: 'danger' as const,
            onSelect: () => setBulkDeleting(true),
          },
        ]
      : []),
  ];

  const confirmDelete = async () => {
    if (!confirming) return;

    const target = confirming;
    setConfirming(null);

    try {
      await withToken((token) => deleteDocument(token, target.id));
      setDocuments((current) => current.filter((item) => item.id !== target.id));
      toast.success(interpolate(tConfirm.deleteDocumentBody, { name: target.name }));
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  const confirmDeleteFolder = async () => {
    if (!deletingFolder) return;

    const target = deletingFolder;
    setDeletingFolder(null);

    try {
      await withToken((token) => deleteFolder(token, target.id));
      setFolders((current) => current.filter((folder) => folder.id !== target.id));

      /*
       * Fall back to "all files" when the folder being viewed is the one that
       * just went. Leaving `folderId` pointing at a deleted folder would leave
       * the list filtered by something the tree no longer shows.
       */
      if (folderId === target.id) {
        setFolderId(undefined);
      }

      toast.success(tFolders.deleted);
    } catch (error) {
      // FOLDER_NOT_EMPTY lands here, and the dictionary already translates it —
      // the API refuses to delete a folder with anything still in it.
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  const submitFolder = async (event: React.FormEvent) => {
    event.preventDefault();

    const name = folderName.trim();

    if (!name) {
      setFolderError(tFolders.errors.required);
      return;
    }

    try {
      const created = await withToken((token) => createFolder(token, { name, parentId: folderId }));
      setFolders((current) => [...current, created]);
      setCreatingFolder(false);
      setFolderName('');
      setFolderError(undefined);
      toast.success(interpolate(tFolders.created, { name: created.name }));
    } catch (error) {
      setFolderError(errorMessage(error, errors, common.genericError));
    }
  };

  const reprocess = async (item: DocumentSummary) => {
    try {
      const updated = await withToken((token) => reprocessDocument(token, item.id));

      // Optimistic only as far as the status: the rest arrives over the stream
      // as the worker moves through OCR and analysis.
      setDocuments((current) =>
        current.map((row) => (row.id === updated.id ? { ...row, status: updated.status } : row)),
      );

      toast.success(interpolate(t.processing.reprocessed, { name: item.name }));
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  const actionsFor = (item: DocumentSummary): RowAction[] => [
    // Offered for every document. The dialog itself explains the types it
    // cannot render, which is steadier than an action that comes and goes.
    { key: 'preview', label: t.actions.quickLook, onSelect: () => setPreviewing(item) },
    { key: 'download', label: t.actions.download, onSelect: () => void download(item) },
    {
      key: 'approval',
      label: t.actions.requestApproval,
      onSelect: () => setRequestingApproval(item),
    },
    /**
     * Hidden while a worker already has the document — the API answers a second
     * request with 409, and offering a button that is guaranteed to fail is
     * worse than not offering it.
     */
    ...(isProcessing(item.status)
      ? []
      : [
          {
            key: 'reprocess',
            label: t.actions.reprocess,
            onSelect: () => void reprocess(item),
          },
        ]),
    {
      key: 'delete',
      label: t.actions.delete,
      tone: 'danger' as const,
      onSelect: () => setConfirming(item),
    },
  ];

  const currentFolderName = folderId
    ? (folders.find((folder) => folder.id === folderId)?.name ?? t.allFiles)
    : t.allFiles;

  /**
   * One tree, rendered in two places — the desktop sidebar and the drawer that
   * stands in for it below `lg`. Built here so the two cannot drift apart as
   * props are added.
   */
  const folderTree = (onSelected?: () => void) => (
    <FolderTree
      folders={folders}
      selectedId={folderId}
      onSelect={(id) => {
        setFolderId(id);
        onSelected?.();
      }}
      // Omitted rather than disabled: FolderTree drops both the hover button and
      // the right-click item when this is absent, so a Member is not shown an
      // action that can only ever answer 403.
      onDelete={canDeleteFolders ? setDeletingFolder : undefined}
      locale={lang}
      t={t}
      tFolders={tFolders}
    />
  );

  return (
    <DropZone onFiles={setPendingFiles} folderName={currentFolderName} t={tUpload}>
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-8"
      >
        <PageHeader
          variants={respectMotion(riseItem, reduced)}
          eyebrow={t.title}
          title={currentFolderName}
          description={t.subtitle}
        />

        <motion.div
          variants={respectMotion(riseItem, reduced)}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="min-w-52 flex-1">
            <TextField
              label={t.searchLabel}
              placeholder={t.searchPlaceholder}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              type="search"
            />
          </div>

          {/*
           * The only route to the folder tree below `lg`, where the sidebar is
           * hidden. Without it a tablet is stuck on "All files" — the filter
           * exists but nothing can reach it.
           */}
          <Button
            variant="secondary"
            className="lg:hidden"
            onClick={() => setBrowsingFolders(true)}
          >
            {t.folders}
          </Button>

          <Button onClick={() => filePicker.current?.click()}>{t.upload}</Button>
          <Button variant="secondary" onClick={() => setCreatingFolder(true)}>
            {t.newFolder}
          </Button>

          <input
            ref={filePicker}
            type="file"
            multiple
            className="sr-only"
            onChange={(event) => {
              setPendingFiles(Array.from(event.target.files ?? []));
              // Reset, or picking the same file twice in a row fires nothing.
              event.target.value = '';
            }}
          />
        </motion.div>

        {/*
          A second row rather than more controls in the first. The first row is
          what you DO — search, upload, create; this is what you are LOOKING at.
          Mixing them puts a destructive-feeling "Upload" beside a harmless
          toggle and makes both harder to find.
        */}
        <motion.div
          variants={respectMotion(riseItem, reduced)}
          className="-mt-4 flex flex-wrap items-end gap-x-3 gap-y-2"
        >
          <FilterChip
            pressed={favorite}
            onPressedChange={setFavorite}
            label={t.favorites.filter}
            icon={
              <svg viewBox="0 0 20 20" className="size-3.5" fill="currentColor" aria-hidden="true">
                <path d="M10 2.6l2.24 4.54 5.01.73-3.62 3.53.85 4.99L10 14.04l-4.48 2.35.85-4.99L2.75 7.87l5.01-.73L10 2.6z" />
              </svg>
            }
          />

          <FilterChip
            pressed={includeArchived}
            onPressedChange={setIncludeArchived}
            label={t.filters.archived}
          />

          {canReadTags && vocabulary.length > 0 ? (
            <Select
              label={t.filters.tag}
              value={tagId ?? ''}
              onChange={(event) => setTagId(event.target.value || undefined)}
              className="h-9 w-48 text-xs"
            >
              <option value="">{t.filters.allTags}</option>
              {vocabulary.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name} ({tag.documentCount})
                </option>
              ))}
            </Select>
          ) : null}

          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFavorite(false);
                setIncludeArchived(false);
                setTagId(undefined);
              }}
            >
              {t.filters.clear}
            </Button>
          ) : null}
        </motion.div>

        {pendingFiles.length > 0 ? (
          <UploadQueue
            files={pendingFiles}
            folderId={folderId}
            t={tUpload}
            errors={errors}
            common={common}
            onUploaded={(created) => setDocuments((current) => [created, ...current])}
            onIdle={() => setPendingFiles([])}
          />
        ) : null}

        <motion.div
          variants={respectMotion(riseItem, reduced)}
          className="grid gap-6 lg:grid-cols-[13rem_1fr]"
        >
          <aside className="hidden lg:block">{folderTree()}</aside>

          <section className="min-w-0">
            {load === 'loading' ? (
              <SkeletonRegion
                label={t.loading}
                className="border-border bg-surface rounded-xl border"
              >
                <SkeletonRows />
              </SkeletonRegion>
            ) : null}

            {load === 'error' ? (
              <div className="border-danger-border bg-danger-subtle rounded-xl border px-6 py-10 text-center">
                <h2 className="font-display text-lg">{t.error.title}</h2>
                <p className="text-text-muted mt-2 text-sm">{message}</p>
                <Button
                  variant="secondary"
                  className="mt-5"
                  onClick={() => {
                    setLoad('loading');
                    refresh();
                  }}
                >
                  {t.error.retry}
                </Button>
              </div>
            ) : null}

            {load === 'ready' && documents.length === 0 ? (
              debounced ? (
                <EmptyState
                  icon={<DocumentGlyph />}
                  title={t.emptySearch.title}
                  body={interpolate(t.emptySearch.body, { query: debounced })}
                  action={
                    <Button variant="secondary" onClick={() => setSearch('')}>
                      {t.emptySearch.clear}
                    </Button>
                  }
                />
              ) : filtered ? (
                /*
                 * Distinct from the "nothing filed yet" state below, and from
                 * the search one above. An empty result under a filter is not
                 * an empty account — offering "Upload your first document" to
                 * someone who has ten thousand of them and has simply ticked
                 * "Starred" reads as data loss.
                 */
                <EmptyState
                  icon={<DocumentGlyph />}
                  title={
                    favorite && !includeArchived && !tagId
                      ? t.favorites.emptyTitle
                      : t.filters.emptyTitle
                  }
                  body={
                    favorite && !includeArchived && !tagId
                      ? t.favorites.emptyBody
                      : t.filters.emptyBody
                  }
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setFavorite(false);
                        setIncludeArchived(false);
                        setTagId(undefined);
                      }}
                    >
                      {t.filters.clear}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<FolderGlyph />}
                  title={folderId ? t.emptyFolder.title : t.empty.title}
                  body={folderId ? t.emptyFolder.body : t.empty.body}
                  action={<Button onClick={() => filePicker.current?.click()}>{t.upload}</Button>}
                />
              )
            ) : null}

            {load === 'ready' && documents.length > 0 ? (
              <>
                <div className="border-border bg-surface overflow-hidden rounded-xl border">
                  {/* Column headings, hidden where the columns themselves are. */}
                  <div className="text-text-subtle border-border hidden items-center gap-4 border-b px-4 py-2 text-xs font-medium tracking-wide uppercase sm:flex">
                    {selectable ? (
                      <Checkbox
                        label={t.selection.all}
                        hideLabel
                        checked={allSelected}
                        // A tick when three of fifty rows are selected is a lie
                        // the reader acts on. `indeterminate` is a DOM property
                        // with no HTML attribute, which is why Checkbox assigns
                        // it through a ref.
                        indeterminate={selected.length > 0 && !allSelected}
                        onChange={(event) => toggleAll(event.target.checked)}
                      />
                    ) : null}
                    <span className="size-9 shrink-0" aria-hidden="true" />
                    <span className="flex-1">{t.columns.name}</span>
                    <span className="w-20 text-end">{t.columns.size}</span>
                    <span className="hidden w-28 text-end md:block">{t.columns.modified}</span>
                    <span className="size-8 shrink-0" aria-hidden="true" />
                  </div>

                  <div className="divide-border divide-y">
                    {documents.map((item) => (
                      <DocumentRow
                        key={item.id}
                        item={item}
                        locale={lang}
                        t={t}
                        actions={actionsFor(item)}
                        // Clicking the name is the quickest path to a look at
                        // the file.
                        href={`/${lang}/documents/${item.id}`}
                        onOpen={() => setPreviewing(item)}
                        selected={selected.includes(item.id)}
                        select={
                          selectable ? (
                            <Checkbox
                              label={interpolate(t.selection.row, { name: item.name })}
                              hideLabel
                              checked={selected.includes(item.id)}
                              onChange={(event) => toggleRow(item.id, event.target.checked)}
                            />
                          ) : null
                        }
                        star={
                          <FavoriteStar
                            id={item.id}
                            name={item.name}
                            favorite={item.isFavorite ?? false}
                            /*
                             * Patched in place, even when the favourites filter
                             * is on and the row no longer matches. Making a row
                             * vanish the instant its star is cleared turns a
                             * misclick into something the reader has to go and
                             * find again; the next load settles it.
                             */
                            onChange={(next) =>
                              setDocuments((current) =>
                                current.map((row) =>
                                  row.id === item.id ? { ...row, isFavorite: next } : row,
                                ),
                              )
                            }
                            t={t}
                            errors={errors}
                            common={common}
                            size="sm"
                          />
                        }
                        onTagSelect={canReadTags ? (tag) => setTagId(tag.id) : undefined}
                      />
                    ))}
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between gap-4">
                  <p className="text-text-subtle text-xs">
                    {documents.length === 1
                      ? t.countOne
                      : interpolate(t.countMany, { count: documents.length })}
                  </p>

                  {cursor ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={loadingMore}
                      onClick={() => void loadMore()}
                    >
                      {t.loadMore}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}

            <BulkBar
              count={selected.length}
              actions={bulkActions}
              busy={bulkBusy}
              outcome={outcome}
              onDismiss={() => setOutcome(null)}
              onClear={() => setSelected([])}
              t={tBulk}
              errors={errors}
              common={common}
            />
          </section>
        </motion.div>
      </motion.div>

      {/*
        Closes on selection: picking a folder is the only reason it was opened,
        and making the reader dismiss it afterwards would turn one decision into
        two taps.
      */}
      <Drawer
        open={browsingFolders}
        onClose={() => setBrowsingFolders(false)}
        title={t.folders}
        closeLabel={common.close}
        rtl={direction[lang] === 'rtl'}
      >
        {folderTree(() => setBrowsingFolders(false))}
      </Drawer>

      <DocumentPreview
        /**
         * A fresh instance per document, so the previous file's blob is
         * released and the new one starts from its loading state.
         *
         * Namespaced, because the dialog below is keyed the same way: two
         * siblings both falling back to a bare 'none' while nothing is open
         * are two children of one array with the same key, which React warns
         * about and which lets it confuse the two components' state.
         */
        key={`preview-${previewing?.id ?? 'none'}`}
        item={previewing}
        onClose={() => setPreviewing(null)}
        t={t}
        errors={errors}
        common={common}
        onDownload={(item) => void download(item)}
      />

      <RequestApprovalDialog
        // Fresh fields per document, rather than resetting them in an effect.
        // Namespaced for the same reason as the preview above.
        key={`approval-${requestingApproval?.id ?? 'none'}`}
        item={requestingApproval}
        onClose={() => setRequestingApproval(null)}
        t={tApprovals}
        errors={errors}
        common={common}
      />

      <Dialog
        open={creatingFolder}
        onClose={() => setCreatingFolder(false)}
        title={tFolders.createTitle}
      >
        <form onSubmit={(event) => void submitFolder(event)} noValidate>
          <TextField
            label={tFolders.nameLabel}
            placeholder={tFolders.namePlaceholder}
            value={folderName}
            error={folderError}
            onChange={(event) => {
              setFolderName(event.target.value);
              setFolderError(undefined);
            }}
          />

          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreatingFolder(false)}>
              {tFolders.cancel}
            </Button>
            <Button type="submit">{tFolders.submit}</Button>
          </div>
        </form>
      </Dialog>

      {/*
        A confirmation for the batch, even though a single delete has one too.
        Fifty rows is where the trash stops being an obvious undo — the reader
        has to find fifty things again — so the count is in the question.
      */}
      <Dialog
        open={bulkDeleting}
        onClose={() => setBulkDeleting(false)}
        title={interpolate(tBulk.deleteTitle, { count: selected.length })}
        description={tBulk.deleteBody}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkDeleting(false)}>
              {tBulk.cancel}
            </Button>
            <Button
              onClick={() => {
                setBulkDeleting(false);
                void runBulk('delete', (ids) => withToken((token) => bulkDelete(token, ids)));
              }}
            >
              {tBulk.deleteSubmit}
            </Button>
          </>
        }
      />

      <Dialog
        open={moving}
        onClose={() => setMoving(false)}
        title={interpolate(tBulk.moveTitle, { count: selected.length })}
      >
        <Select
          label={tBulk.moveLabel}
          value={moveTo}
          onChange={(event) => setMoveTo(event.target.value)}
        >
          {/* The root is a real destination, not the absence of one. */}
          <option value="">{tBulk.moveRoot}</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </Select>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setMoving(false)}>
            {tBulk.cancel}
          </Button>
          <Button
            onClick={() => {
              setMoving(false);
              void runBulk('move', (ids) =>
                withToken((token) => bulkMove(token, ids, moveTo || null)),
              );
            }}
          >
            {tBulk.moveSubmit}
          </Button>
        </div>
      </Dialog>

      {/*
        Two pickers, because this is a DELTA. A single "these are the tags now"
        field would clear labels the reader never saw, on rows they never opened.
      */}
      <Dialog
        open={tagging}
        onClose={() => setTagging(false)}
        title={interpolate(tBulk.tagTitle, { count: selected.length })}
        description={tBulk.tagHint}
      >
        <div className="flex flex-col gap-4">
          <TagInput
            options={vocabulary}
            value={tagAdd}
            // A tag named on both sides is refused by the API rather than
            // resolved by picking an order, so it is kept out of the other list
            // here instead of being offered and then rejected.
            onChange={(ids) => {
              setTagAdd(ids);
              setTagRemove((current) => current.filter((id) => !ids.includes(id)));
            }}
            label={tBulk.tagAdd}
            placeholder={tTags.placeholder}
            allowCreate={canCreateTags}
            labels={{
              remove: tTags.remove,
              create: tTags.create,
              empty: tTags.noMatches,
              full: interpolate(tTags.full, { count: 20 }),
            }}
          />

          <TagInput
            options={vocabulary}
            value={tagRemove}
            onChange={(ids) => {
              setTagRemove(ids);
              setTagAdd((current) => current.filter((id) => !ids.includes(id)));
            }}
            label={tBulk.tagRemove}
            placeholder={tTags.placeholder}
            labels={{
              remove: tTags.remove,
              create: tTags.create,
              empty: tTags.noMatches,
              full: interpolate(tTags.full, { count: 20 }),
            }}
          />
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setTagging(false)}>
            {tBulk.cancel}
          </Button>
          <Button
            // A batch that asks for nothing is a BULK_NO_CHANGES from the API;
            // refusing it here means the reader never meets that error.
            disabled={tagAdd.length === 0 && tagRemove.length === 0}
            onClick={() => {
              setTagging(false);
              void runBulk('tag', (ids) =>
                withToken((token) =>
                  bulkSetTags(token, ids, {
                    add: tagAdd.length > 0 ? tagAdd : undefined,
                    remove: tagRemove.length > 0 ? tagRemove : undefined,
                  }),
                ),
              ).then(() => {
                setTagAdd([]);
                setTagRemove([]);
              });
            }}
          >
            {tBulk.tagSubmit}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={tConfirm.deleteDocumentTitle}
        description={
          confirming
            ? interpolate(tConfirm.deleteDocumentBody, { name: confirming.name })
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {tConfirm.cancel}
            </Button>
            <Button onClick={() => void confirmDelete()}>{tConfirm.deleteDocumentSubmit}</Button>
          </>
        }
      />

      {/*
        Separate from the document dialog above, not a shared one parameterised
        by kind: the wording differs (a folder is gone for good, a document goes
        to the trash), and merging them would mean a conditional inside every
        string.
      */}
      <Dialog
        open={deletingFolder !== null}
        onClose={() => setDeletingFolder(null)}
        title={tFolders.deleteTitle}
        description={
          deletingFolder
            ? interpolate(tFolders.deleteBody, { name: deletingFolder.name })
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeletingFolder(null)}>
              {tFolders.cancel}
            </Button>
            <Button onClick={() => void confirmDeleteFolder()}>{tFolders.deleteSubmit}</Button>
          </>
        }
      />
    </DropZone>
  );
}

/**
 * A two-state filter, as a toggle button rather than a checkbox.
 *
 * `aria-pressed` is what makes it one: a checkbox announces "checked", which
 * describes a value being collected, whereas this changes what is on screen the
 * moment it is pressed. Same reason the "select all" control above IS a
 * checkbox — that one really is a selection.
 */
function FilterChip({
  pressed,
  onPressedChange,
  label,
  icon,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        'flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium',
        'transition-[background-color,border-color,color] duration-fast ease-out-quint',
        'focus-visible:outline-focus focus-visible:outline-2 focus-visible:outline-offset-2',
        pressed
          ? 'border-accent-border bg-accent-subtle text-accent'
          : 'border-border-strong bg-surface text-text-muted hover:border-text-subtle hover:text-text',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
