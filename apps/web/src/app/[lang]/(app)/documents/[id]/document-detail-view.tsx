'use client';

import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { CommentThread } from '@/components/documents/comment-thread';
import {
  DocumentBytes,
  ExtractedText,
  StageDot,
  Summary,
} from '@/components/documents/document-panels';
import { DocumentStatusBadge } from '@/components/documents/document-status';
import { DocumentTagsPanel } from '@/components/documents/document-tags';
import { FavoriteStar } from '@/components/documents/favorite-star';
import { VersionHistory } from '@/components/documents/version-history';
import { useLiveEvent } from '@/components/providers/live-provider';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, DocumentGlyph } from '@/components/ui/empty-state';
import { Menu, type MenuAction, type MenuOrigin } from '@/components/ui/menu';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/toast';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { fetchProfile } from '@/lib/auth';
import {
  archiveDocument,
  deleteDocument,
  formatBytes,
  getDocument,
  reprocessDocument,
  unarchiveDocument,
  type DocumentDetail,
} from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { riseItem, respectMotion, stagger } from '@/lib/motion';
import { useDocumentDownload } from '@/lib/use-download';

/** Runtime list as well as a type, because `?tab=` arrives as an untrusted string. */
const TABS = ['document', 'text', 'summary', 'versions', 'comments'] as const;

type Tab = (typeof TABS)[number];

type Load =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; detail: DocumentDetail };

/**
 * One document, in full.
 *
 * The list answers "what do we have"; this answers "what is this". It is the
 * only screen that shows the aggregate the schema actually models — file plus
 * metadata plus versions plus the audit-relevant facts — rather than the row
 * projection the browser needs to stay fast at ten thousand items.
 *
 * A 404 is NOT an error state here. `notFound` is a real answer to a real
 * question: the document was trashed, or the link is stale, or it belongs to
 * another company and the tenant guard is correctly refusing to say which. All
 * three deserve the same designed page rather than a red box.
 */
export function DocumentDetailView({
  id,
  lang,
  t,
  tTags,
  tComments,
  errors,
  common,
  confirm,
}: {
  id: string;
  lang: Locale;
  t: Dictionary['documents'];
  tTags: Dictionary['tags'];
  tComments: Dictionary['comments'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  confirm: Dictionary['confirm'];
}) {
  const { withToken } = useSession();
  const toast = useToast();
  const router = useRouter();
  const reduced = useReducedMotion();
  const tabsId = useId();
  const download = useDocumentDownload(errors, common);

  /**
   * `?tab=` is honoured, so a notification lands on the thing it is about.
   *
   * "{actor} commented on X" that opens the file preview has still not shown
   * the reader what they clicked for. Read once, as the initial value rather
   * than as a controlling prop: after arrival the tab strip is the reader's, and
   * a URL that kept overriding it would fight every click.
   *
   * An unknown value falls through to the document, so a hand-edited or stale
   * link opens the page rather than an empty panel.
   */
  const requested = useSearchParams().get('tab');
  const initialTab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : 'document';

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [permissions, setPermissions] = useState<string[]>([]);
  /** Whose comments may be edited is decided against this, not against a permission. */
  const [me, setMe] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [origin, setOrigin] = useState<MenuOrigin | null>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * Held here rather than inside the thread so the tab badge survives a switch
   * away from it — the thread unmounts with the panel, and a count that vanished
   * whenever you looked at the file would be worse than none.
   */
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const menuId = useId();

  const variants = respectMotion(riseItem, reduced);

  /**
   * Bumped to refetch. A counter rather than calling the loader directly, so the
   * live handler stays a plain state update and every fetch lives in one effect.
   */
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let current = true;

    void (async () => {
      try {
        const [detail, profile] = await Promise.all([
          withToken((token) => getDocument(token, id)),
          withToken(fetchProfile),
        ]);

        if (!current) return;

        setPermissions(profile.permissions);
        setMe(profile.id);
        setLoad({ kind: 'ready', detail });
      } catch (error) {
        if (!current) return;

        // A 404 means "not here", whatever the underlying reason — trashed,
        // mistyped, or another company's. All three get the same page.
        const status = (error as { status?: number }).status;

        setLoad(
          status === 404
            ? { kind: 'missing' }
            : { kind: 'error', message: errorMessage(error, errors, common.genericError) },
        );
      }
    })();

    return () => {
      current = false;
    };
  }, [id, withToken, errors, common.genericError, reloadKey]);

  /**
   * A document opened mid-pipeline fills in as the worker finishes, without the
   * page being reloaded — which is the whole reason the event stream exists.
   */
  useLiveEvent((event) => {
    if (event.type === 'document.status' && event.documentId === id) {
      reload();
    }
  });

  const detail = load.kind === 'ready' ? load.detail : null;

  const canUpdate = permissions.includes('documents.update');
  const canDelete = permissions.includes('documents.delete');
  // Both, because adding a version is an upload AND a rewrite of what everyone
  // else opens. The API demands the pair too.
  const canVersion = canUpdate && permissions.includes('documents.create');
  const canComment = permissions.includes('comments.create');
  const canModerate = permissions.includes('comments.moderate');
  // `tags.manage` is the privileged half: applying a label is ordinary document
  // work, inventing one everybody then sees is not.
  const canCreateTags = permissions.includes('tags.manage');

  const setStatus = async (archive: boolean) => {
    if (!detail) return;

    try {
      const updated = await withToken((token) =>
        archive ? archiveDocument(token, detail.id) : unarchiveDocument(token, detail.id),
      );

      setLoad({ kind: 'ready', detail: { ...detail, status: updated.status } });
      toast.success(
        interpolate(archive ? t.detail.archivedToast : t.detail.unarchivedToast, {
          name: detail.name,
        }),
      );
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  const reprocess = async () => {
    if (!detail) return;

    try {
      const updated = await withToken((token) => reprocessDocument(token, detail.id));

      // Optimistic only as far as the status: the rest arrives over the stream
      // as the worker moves through OCR and analysis.
      setLoad({ kind: 'ready', detail: { ...detail, status: updated.status } });
      toast.success(interpolate(t.processing.reprocessed, { name: detail.name }));
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  const confirmDelete = async () => {
    if (!detail) return;

    try {
      await withToken((token) => deleteDocument(token, detail.id));
      toast.success(confirm.deleteDocumentSubmit);

      // Back to the list: staying on the detail page of a trashed document would
      // leave the reader looking at something the next reload 404s.
      router.replace(`/${lang}/documents`);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
      setDeleting(false);
    }
  };

  if (load.kind === 'loading') {
    return (
      <SkeletonRegion label={t.detail.loading} className="flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-80 max-w-full" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <Skeleton className="h-[50dvh] w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </SkeletonRegion>
    );
  }

  if (load.kind === 'missing') {
    return (
      <EmptyState
        icon={<DocumentGlyph />}
        title={t.detail.notFound.title}
        body={t.detail.notFound.body}
        action={
          <Button onClick={() => router.push(`/${lang}/documents`)}>
            {t.detail.notFound.action}
          </Button>
        }
      />
    );
  }

  if (load.kind === 'error') {
    return (
      <Card className="text-center" padding="lg">
        <h1 className="font-display text-lg">{t.detail.error.title}</h1>
        <p className="text-text-muted mt-2 text-sm">{load.message}</p>
        <Button className="mt-5" variant="secondary" onClick={reload}>
          {t.detail.error.retry}
        </Button>
      </Card>
    );
  }

  const document = load.detail;
  const archived = document.status === 'ARCHIVED';

  const actions: MenuAction[] = [
    ...(canUpdate
      ? [
          archived
            ? {
                key: 'unarchive',
                label: t.actions.unarchive,
                onSelect: () => void setStatus(false),
              }
            : { key: 'archive', label: t.actions.archive, onSelect: () => void setStatus(true) },
          { key: 'reprocess', label: t.actions.reprocess, onSelect: () => void reprocess() },
        ]
      : []),
    ...(canDelete
      ? [
          {
            key: 'delete',
            label: t.actions.delete,
            tone: 'danger' as const,
            onSelect: () => setDeleting(true),
          },
        ]
      : []),
  ];

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <PageHeader
        variants={variants}
        eyebrow={
          <span className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/${lang}/documents`}
              className="hover:text-text focus-visible:outline-focus rounded-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {t.title}
            </Link>
            {document.folder ? (
              <>
                <span aria-hidden="true">/</span>
                <Link
                  href={`/${lang}/documents?folderId=${document.folder.id}`}
                  className="hover:text-text focus-visible:outline-focus rounded-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {document.folder.name}
                </Link>
              </>
            ) : null}
          </span>
        }
        title={<span className="latin">{document.name}</span>}
        actions={
          <>
            {/*
              First in the row, and deliberately not in the menu: starring is
              the one action here that is private, instant and reversible, and
              burying a bookmark two clicks deep is how a shortlist stops being
              used.
            */}
            <FavoriteStar
              id={document.id}
              name={document.name}
              favorite={document.isFavorite}
              onChange={(favorite) =>
                setLoad({ kind: 'ready', detail: { ...document, isFavorite: favorite } })
              }
              t={t}
              errors={errors}
              common={common}
            />

            <Button variant="secondary" onClick={() => void download(document)}>
              {t.actions.download}
            </Button>

            {actions.length > 0 ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={(event) =>
                    setOrigin((current) =>
                      current ? null : { kind: 'element', el: event.currentTarget },
                    )
                  }
                  aria-haspopup="menu"
                  aria-expanded={origin !== null}
                  aria-controls={origin ? menuId : undefined}
                  aria-label={interpolate(t.actions.menu, { name: document.name })}
                  className="text-text-subtle hover:text-text hover:bg-surface-inset focus-visible:outline-focus flex size-10 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <circle cx="8" cy="3" r="1.4" />
                    <circle cx="8" cy="8" r="1.4" />
                    <circle cx="8" cy="13" r="1.4" />
                  </svg>
                </button>

                <Menu
                  id={menuId}
                  origin={origin}
                  onClose={() => setOrigin(null)}
                  actions={actions}
                  label={interpolate(t.actions.menu, { name: document.name })}
                />
              </div>
            ) : null}
          </>
        }
      />

      {/*
        Archive is a status, not a place — the document is still here, still
        downloadable, still open to comment. Saying so is what stops "why can I
        not rename this" being a support question.
      */}
      {archived ? (
        <motion.div variants={variants}>
          <Card tone="sunken" padding="sm" className="flex items-start gap-3">
            <Badge tone="neutral" dot className="mt-0.5 shrink-0">
              {t.detail.archived.title}
            </Badge>
            <p className="text-text-muted text-xs text-pretty">{t.detail.archived.body}</p>
          </Card>
        </motion.div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <motion.section variants={variants} className="min-w-0">
          <Tabs
            idBase={tabsId}
            label={document.name}
            value={tab}
            onChange={setTab}
            className="mb-4"
            items={[
              { value: 'document', label: t.detail.tabs.document },
              {
                value: 'text',
                label: t.detail.tabs.text,
                badge: <StageDot stage={document.metadata?.ocrStatus} />,
              },
              {
                value: 'summary',
                label: t.detail.tabs.summary,
                badge: <StageDot stage={document.metadata?.aiStatus} />,
              },
              {
                value: 'versions',
                label: t.detail.tabs.versions,
                badge:
                  document.versions.length > 1 ? (
                    <span className="text-text-subtle text-2xs">{document.versions.length}</span>
                  ) : null,
              },
              {
                value: 'comments',
                label: t.detail.tabs.comments,
                // Only once there is something to count. A "0" on a fresh
                // document reads as an error rather than as an empty thread.
                badge: commentCount ? (
                  <span className="text-text-subtle text-2xs tabular-nums">{commentCount}</span>
                ) : null,
              },
            ]}
          />

          <TabPanel idBase={tabsId} value="document" selected={tab}>
            <DocumentBytes
              item={document}
              detail={document}
              t={t}
              errors={errors}
              common={common}
              onDownload={() => void download(document)}
              height="h-[62dvh]"
            />
          </TabPanel>

          <TabPanel idBase={tabsId} value="text" selected={tab}>
            <ExtractedText
              detail={document}
              t={t}
              className="border-border bg-surface-inset text-text max-h-[62dvh] overflow-auto rounded-lg border p-5 font-mono text-xs leading-relaxed whitespace-pre-wrap"
            />
          </TabPanel>

          <TabPanel idBase={tabsId} value="summary" selected={tab}>
            <Card padding="lg">
              <Summary detail={document} t={t} />
            </Card>
          </TabPanel>

          <TabPanel idBase={tabsId} value="versions" selected={tab}>
            <Card padding="lg">
              <VersionHistory
                detail={document}
                locale={lang}
                t={t}
                errors={errors}
                common={common}
                confirm={confirm}
                canWrite={canVersion}
                onChanged={reload}
              />
            </Card>
          </TabPanel>

          {/*
            NOT gated on the archive. `assertWritable` refuses renames, moves and
            new versions on an archived document and is deliberately not applied
            to the conversation: freezing what a record IS does not mean sealing
            away what is said about it.
          */}
          <TabPanel idBase={tabsId} value="comments" selected={tab}>
            <Card padding="lg">
              <CommentThread
                documentId={document.id}
                locale={lang}
                me={me}
                canComment={canComment}
                canModerate={canModerate}
                onTotalChange={setCommentCount}
                t={tComments}
                errors={errors}
                common={common}
                confirm={confirm}
              />
            </Card>
          </TabPanel>
        </motion.section>

        <motion.aside variants={variants} className="flex min-w-0 flex-col gap-6">
          {/*
            Above the facts, not among them. Everything in the details card is
            something the system knows about the file; tags are the one thing on
            this page a person decides, and burying an editor inside a
            description list would read as another read-only row.
          */}
          <Card padding="md" className="flex flex-col gap-4">
            <CardHeader title={tTags.title} />

            <DocumentTagsPanel
              documentId={document.id}
              tags={document.tags}
              canEdit={canUpdate}
              canCreate={canCreateTags}
              archived={archived}
              onChange={(tags) => setLoad({ kind: 'ready', detail: { ...document, tags } })}
              t={tTags}
              errors={errors}
              common={common}
            />
          </Card>

          <Card padding="md" className="flex flex-col gap-4">
            <CardHeader title={t.detail.about.title} />

            <dl className="flex flex-col gap-3.5">
              <Fact label={t.detail.about.status}>
                {/*
                  The badge renders nothing for a healthy READY document, which
                  is right in a list but leaves a blank field here — so the
                  status name is the fallback.
                */}
                <DocumentStatusBadge
                  status={document.status}
                  ocrStatus={document.metadata?.ocrStatus}
                  aiStatus={document.metadata?.aiStatus}
                  ocrError={document.metadata?.ocrError}
                  aiError={document.metadata?.aiError}
                  t={t}
                />
                {document.status === 'READY' &&
                document.metadata?.ocrStatus !== 'FAILED' &&
                document.metadata?.aiStatus !== 'FAILED' ? (
                  <span className="text-sm">{t.status.READY}</span>
                ) : null}
              </Fact>

              <Fact label={t.detail.about.owner}>
                <span className="flex w-full min-w-0 items-center gap-2">
                  <Avatar
                    firstName={document.owner.firstName}
                    lastName={document.owner.lastName}
                    size="sm"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">
                      {document.owner.firstName} {document.owner.lastName}
                    </span>
                    {/* Addresses read left-to-right even on an Arabic page. */}
                    <span
                      dir="ltr"
                      className="text-text-subtle block truncate text-xs rtl:text-end"
                    >
                      {document.owner.email}
                    </span>
                  </span>
                </span>
              </Fact>

              <Fact label={t.detail.about.folder}>
                <Link
                  href={
                    document.folder
                      ? `/${lang}/documents?folderId=${document.folder.id}`
                      : `/${lang}/documents`
                  }
                  className="text-accent focus-visible:outline-focus rounded-xs text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {document.folder?.name ?? t.detail.about.root}
                </Link>
              </Fact>

              <Fact label={t.detail.about.type}>
                <span className="latin text-sm">{document.extension.toUpperCase()}</span>
                {/*
                  Same flex-item shrink rule as the checksum. A .docx reports
                  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
                  which is longer than the whole 20rem column.
                */}
                <span
                  title={document.mimeType}
                  className="text-text-subtle block w-full min-w-0 truncate font-mono text-xs"
                >
                  {document.mimeType}
                </span>
              </Fact>

              <Fact label={t.detail.about.size}>
                <span className="text-sm">{formatBytes(document.size, lang)}</span>
              </Fact>

              <Fact label={t.detail.about.created}>
                <Stamp value={document.createdAt} locale={lang} />
              </Fact>

              <Fact label={t.detail.about.updated}>
                <Stamp value={document.updatedAt} locale={lang} />
              </Fact>

              {document.hash ? (
                <Fact label={t.detail.about.hash}>
                  <Tooltip content={t.detail.about.hashHint}>
                    {/*
                      Truncated with the full value on the element, because a
                      64-character hex string in a 20rem column either wraps to
                      four lines or bursts the layout — and it is a value you
                      compare, not one you read.
                    */}
                    <span
                      dir="ltr"
                      tabIndex={0}
                      title={document.hash}
                      // `min-w-0 w-full` alongside `truncate`: this is a flex
                      // item, and without a min-width of zero it declines to
                      // shrink and overflows the card rather than ellipsing.
                      className="focus-visible:outline-focus block w-full min-w-0 truncate rounded-xs font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2 rtl:text-end"
                    >
                      {document.hash}
                    </span>
                  </Tooltip>
                </Fact>
              ) : null}
            </dl>
          </Card>
        </motion.aside>
      </div>

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={confirm.deleteDocumentTitle}
        description={interpolate(confirm.deleteDocumentBody, { name: document.name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {confirm.cancel}
            </Button>
            <Button onClick={() => void confirmDelete()}>{confirm.deleteDocumentSubmit}</Button>
          </>
        }
      />
    </motion.div>
  );
}

/** One row of the details panel. A `<dl>` because it is literally a term list. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-text-subtle text-2xs font-medium tracking-wide uppercase">{label}</dt>
      <dd className="mt-1 flex min-w-0 flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

/**
 * A timestamp, with the full one underneath.
 *
 * `<time datetime>` rather than a bare string, so the machine-readable instant
 * survives whatever the locale does to the rendering.
 */
function Stamp({ value, locale }: { value: string; locale: Locale }) {
  const date = new Date(value);

  return (
    <time dateTime={value} className="text-sm">
      {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)}
    </time>
  );
}
