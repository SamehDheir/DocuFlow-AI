'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { DocumentPreview } from '@/components/documents/document-preview';
import { DocumentRow, type RowAction } from '@/components/documents/document-row';
import { DropZone } from '@/components/documents/drop-zone';
import { FolderTree } from '@/components/documents/folder-tree';
import { UploadQueue } from '@/components/documents/upload-queue';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { DocumentGlyph, EmptyState, FolderGlyph } from '@/components/ui/empty-state';
import { SkeletonRegion, SkeletonRows } from '@/components/ui/skeleton';
import { TextField } from '@/components/ui/text-field';
import { useToast } from '@/components/ui/toast';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import {
  createFolder,
  deleteDocument,
  fetchDocumentBlob,
  listDocuments,
  listFolders,
  type DocumentSummary,
  type Folder,
} from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { respectMotion, riseItem, stagger } from '@/lib/motion';

type Load = 'loading' | 'ready' | 'error';

/** Debounce for the search box — one request per keystroke would be absurd. */
const SEARCH_DEBOUNCE_MS = 300;

export function DocumentsView({
  lang,
  t,
  tUpload,
  tFolders,
  tConfirm,
  errors,
  common,
}: {
  lang: Locale;
  t: Dictionary['documents'];
  tUpload: Dictionary['upload'];
  tFolders: Dictionary['folders'];
  tConfirm: Dictionary['confirm'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
}) {
  const { status, withToken } = useSession();
  const toast = useToast();
  const reduced = useReducedMotion();

  const [load, setLoad] = useState<Load>('loading');
  const [message, setMessage] = useState('');
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [folderId, setFolderId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<DocumentSummary | null>(null);
  const [previewing, setPreviewing] = useState<DocumentSummary | null>(null);

  const filePicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const refresh = useCallback(async () => {
    setLoad('loading');

    try {
      const [page, tree] = await Promise.all([
        withToken((token) => listDocuments(token, { folderId, q: debounced })),
        withToken(listFolders),
      ]);

      setDocuments(page.items);
      setCursor(page.nextCursor);
      setFolders(tree);
      setLoad('ready');
    } catch (error) {
      setMessage(errorMessage(error, errors, common.genericError));
      setLoad('error');
    }
  }, [withToken, folderId, debounced, errors, common.genericError]);

  useEffect(() => {
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        const [page, tree] = await Promise.all([
          withToken((token) => listDocuments(token, { folderId, q: debounced })),
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
  }, [status, withToken, folderId, debounced, errors, common.genericError]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;

    setLoadingMore(true);

    try {
      const page = await withToken((token) =>
        listDocuments(token, { folderId, q: debounced, cursor }),
      );
      setDocuments((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setLoadingMore(false);
    }
  };

  const download = async (item: DocumentSummary) => {
    try {
      const url = await withToken((token) => fetchDocumentBlob(token, item.id));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = item.originalName;
      anchor.click();
      // Revoked on the next tick, or the blob is pinned for the page's life.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

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

  const actionsFor = (item: DocumentSummary): RowAction[] => [
    // Offered for every document. The dialog itself explains the types it
    // cannot render, which is steadier than an action that comes and goes.
    { key: 'preview', label: t.actions.open, onSelect: () => setPreviewing(item) },
    { key: 'download', label: t.actions.download, onSelect: () => void download(item) },
    {
      key: 'delete',
      label: t.actions.delete,
      tone: 'danger',
      onSelect: () => setConfirming(item),
    },
  ];

  const currentFolderName = folderId
    ? (folders.find((folder) => folder.id === folderId)?.name ?? t.allFiles)
    : t.allFiles;

  return (
    <DropZone onFiles={setPendingFiles} folderName={currentFolderName} t={tUpload}>
      <motion.div
        variants={stagger}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-8"
      >
        <motion.header variants={respectMotion(riseItem, reduced)}>
          <p className="text-text-subtle text-xs font-medium tracking-wide uppercase">{t.title}</p>
          <h1 className="font-display mt-1 text-3xl sm:text-4xl">{currentFolderName}</h1>
          <p className="text-text-muted mt-2 text-sm">{t.subtitle}</p>
        </motion.header>

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
          <aside className="hidden lg:block">
            <FolderTree
              folders={folders}
              selectedId={folderId}
              onSelect={setFolderId}
              locale={lang}
              t={t}
            />
          </aside>

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
                <Button variant="secondary" className="mt-5" onClick={() => void refresh()}>
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
                        onOpen={() => setPreviewing(item)}
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
          </section>
        </motion.div>
      </motion.div>

      <DocumentPreview
        // A fresh instance per document, so the previous file's blob is
        // released and the new one starts from its loading state.
        key={previewing?.id ?? 'none'}
        item={previewing}
        onClose={() => setPreviewing(null)}
        t={t}
        errors={errors}
        common={common}
        onDownload={(item) => void download(item)}
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
    </DropZone>
  );
}
