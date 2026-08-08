'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { useLiveEvent } from '@/components/providers/live-provider';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { cn } from '@/lib/cn';
import {
  COMMENT_BODY_MAX,
  createComment,
  deleteComment,
  listComments,
  updateComment,
  type Comment,
} from '@/lib/comments';
import { errorMessage } from '@/lib/error-message';
import { DURATION, EASE } from '@/lib/motion';

type Load = 'loading' | 'ready' | 'error';

/**
 * The conversation about one document.
 *
 * Rules that are not obvious from the markup:
 *
 *  - **Editing is author-only, even for a moderator.** `comments.moderate` is
 *    "delete anyone's comment"; putting different words in someone's mouth is
 *    not moderation, and the API refuses it regardless of what this renders.
 *  - **An archived document still takes comments.** Archive freezes what a
 *    document IS, not what is said about it, so nothing here is disabled by it.
 *  - **A deleted comment leaves no tombstone.** The row survives with
 *    `deletedAt` set — the trail keeps it — but the thread simply no longer
 *    lists it, because "[deleted]" placeholders turn a discussion into a record
 *    of arguments.
 */
export function CommentThread({
  documentId,
  locale,
  me,
  canComment,
  canModerate,
  onTotalChange,
  t,
  errors,
  common,
  confirm,
}: {
  documentId: string;
  locale: Locale;
  /** The reader's own user id — who may edit is decided against this. */
  me: string | null;
  canComment: boolean;
  canModerate: boolean;
  /** Reports the thread size upward, so a tab badge and the thread agree. */
  onTotalChange?: (total: number) => void;
  t: Dictionary['comments'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  confirm: Dictionary['confirm'];
}) {
  const { withToken } = useSession();
  const toast = useToast();
  const reduced = useReducedMotion();

  const [load, setLoad] = useState<Load>('loading');
  const [message, setMessage] = useState('');
  const [comments, setComments] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * The thread size, held separately from `comments.length`.
   *
   * They are different numbers: the list is one page, the total is the whole
   * conversation. A badge reading "3" beside thirty comments — or "30" beside a
   * first page of three — is the bug this separation prevents.
   */
  const [total, setTotal] = useState(0);

  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Comment | null>(null);

  /** Bumped to refetch, so every fetch lives in one effect. */
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  /**
   * Comments this tab has just written.
   *
   * `comment.changed` broadcasts to the whole company INCLUDING the author, so
   * without this every post would trigger a refetch of a list we already hold
   * the authoritative response for — and the thread would flicker between the
   * appended row and the refetched one. Ids are remembered rather than a
   * timestamp window, so a colleague's comment arriving in the same second is
   * still picked up.
   */
  const mine = useRef(new Set<string>());

  /**
   * Reported from an effect rather than from each handler, so the count the
   * parent sees is always the one this component last settled on — and so a
   * state updater never has a callback fired inside it.
   */
  useEffect(() => {
    onTotalChange?.(total);
  }, [total, onTotalChange]);

  useEffect(() => {
    let current = true;

    void (async () => {
      try {
        const page = await withToken((token) => listComments(token, documentId));

        if (!current) return;

        setComments(page.items);
        setCursor(page.nextCursor);
        setTotal(page.total);
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
  }, [documentId, withToken, errors, common.genericError, reloadKey]);

  useLiveEvent((event) => {
    if (event.type !== 'comment.changed' || event.documentId !== documentId) {
      return;
    }

    if (mine.current.has(event.commentId)) {
      mine.current.delete(event.commentId);
      return;
    }

    reload();
  });

  /**
   * The edit in progress, but only while its comment is still in the thread.
   *
   * A refetch can arrive mid-edit — a moderator removed the comment, say — and
   * the open form would otherwise stay over nothing and save into a 404.
   * DERIVED rather than cleared from an effect: resetting state in response to
   * other state is the cascading render `react-hooks/set-state-in-effect`
   * rejects, and the stale value is harmless because nothing reads it.
   */
  const openEdit =
    editing && comments.some((comment) => comment.id === editing.id) ? editing : null;

  const loadMore = async () => {
    if (!cursor || loadingMore) return;

    setLoadingMore(true);

    try {
      const page = await withToken((token) => listComments(token, documentId, { cursor }));
      setComments((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
      setTotal(page.total);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setLoadingMore(false);
    }
  };

  const post = async (event: React.FormEvent) => {
    event.preventDefault();

    const body = draft.trim();

    if (!body || posting) return;

    setPosting(true);

    try {
      const created = await withToken((token) => createComment(token, documentId, body));

      mine.current.add(created.id);
      // Appended rather than refetched: the response IS the new row, and a
      // refetch would reorder nothing while costing a round trip during which
      // the reader's own remark is missing from the thread they just added to.
      setComments((current) => [...current, created]);
      setTotal((count) => count + 1);
      setDraft('');
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setPosting(false);
    }
  };

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!openEdit) return;

    const body = openEdit.body.trim();

    if (!body || saving) return;

    setSaving(true);

    try {
      const updated = await withToken((token) => updateComment(token, openEdit.id, body));

      mine.current.add(updated.id);
      setComments((current) =>
        current.map((comment) => (comment.id === updated.id ? updated : comment)),
      );
      setEditing(null);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;

    const target = deleting;
    setDeleting(null);

    try {
      await withToken((token) => deleteComment(token, target.id));

      mine.current.add(target.id);
      setComments((current) => current.filter((comment) => comment.id !== target.id));
      setTotal((count) => Math.max(0, count - 1));
      toast.success(t.deleted);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  if (load === 'loading') {
    return (
      <SkeletonRegion label={t.loading} className="flex flex-col gap-5">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex gap-3">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        ))}
      </SkeletonRegion>
    );
  }

  if (load === 'error') {
    return (
      <div className="border-danger-border bg-danger-subtle rounded-lg border px-5 py-8 text-center">
        <p className="text-text-muted text-sm">{message}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={reload}>
          {t.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
            {t.loadEarlier}
          </Button>
        </div>
      ) : null}

      {comments.length === 0 ? (
        <p className="text-text-subtle py-6 text-center text-sm text-balance">
          {canComment ? t.empty : t.emptyReadOnly}
        </p>
      ) : (
        <ol className="flex flex-col gap-5">
          <AnimatePresence initial={false}>
            {comments.map((comment) => (
              <motion.li
                key={comment.id}
                layout={!reduced}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DURATION.base, ease: EASE.outQuint }}
                className="flex gap-3"
              >
                <Avatar
                  firstName={comment.author.firstName}
                  lastName={comment.author.lastName}
                  size="sm"
                  className="mt-0.5"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium">
                      {comment.author.firstName} {comment.author.lastName}
                    </span>

                    <time
                      dateTime={comment.createdAt}
                      className="text-text-subtle text-xs"
                      title={new Intl.DateTimeFormat(locale, {
                        dateStyle: 'full',
                        timeStyle: 'short',
                      }).format(new Date(comment.createdAt))}
                    >
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(comment.createdAt))}
                    </time>

                    {/*
                      Marked, never silent. Rewriting text a colleague has
                      already replied to without saying so is how a thread
                      starts lying about what was said.
                    */}
                    {comment.editedAt ? (
                      <span className="text-text-subtle text-2xs">{t.edited}</span>
                    ) : null}
                  </div>

                  {openEdit?.id === comment.id ? (
                    <form onSubmit={(event) => void saveEdit(event)} className="mt-2" noValidate>
                      <Textarea
                        label={t.editLabel}
                        value={openEdit.body}
                        maxLength={COMMENT_BODY_MAX}
                        autoFocus
                        onChange={(event) =>
                          setEditing({ id: comment.id, body: event.target.value })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setEditing(null);
                          }
                        }}
                      />

                      <div className="mt-2 flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(null)}
                        >
                          {confirm.cancel}
                        </Button>
                        <Button
                          type="submit"
                          size="sm"
                          loading={saving}
                          disabled={openEdit.body.trim() === ''}
                        >
                          {t.save}
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <>
                      {/*
                        `whitespace-pre-wrap` and nothing else: the body is
                        plain text and is rendered as plain text. No markdown
                        pass, no linkifier — both are HTML-injection surfaces
                        added for a formatting need nobody has stated.
                      */}
                      <p className="text-text mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap">
                        {comment.body}
                      </p>

                      {/*
                        Inline text buttons, not a kebab menu. A thread is a
                        handful of rows rather than ten thousand, so the density
                        argument that put document actions behind a menu does not
                        apply — and one's own comment is the thing most likely to
                        need a quick fix.
                      */}
                      {me === comment.author.id || canModerate ? (
                        <div className="mt-1.5 flex gap-3">
                          {me === comment.author.id ? (
                            <RowButton
                              onClick={() => setEditing({ id: comment.id, body: comment.body })}
                            >
                              {t.edit}
                            </RowButton>
                          ) : null}

                          <RowButton tone="danger" onClick={() => setDeleting(comment)}>
                            {t.delete}
                          </RowButton>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
      )}

      {canComment ? (
        <form
          onSubmit={(event) => void post(event)}
          className="border-border border-t pt-5"
          noValidate
        >
          <Textarea
            label={t.composeLabel}
            placeholder={t.composePlaceholder}
            value={draft}
            rows={3}
            maxLength={COMMENT_BODY_MAX}
            onChange={(event) => setDraft(event.target.value)}
          />

          <div className="mt-3 flex items-center justify-between gap-3">
            {/*
              The counter appears only near the ceiling. Shown always it is
              clutter on a two-line remark; shown never, a long comment is
              refused by a 400 the writer could not have seen coming.
            */}
            <span
              aria-live="polite"
              className={cn(
                'text-text-subtle text-xs tabular-nums',
                draft.length < COMMENT_BODY_MAX * 0.9 && 'invisible',
              )}
            >
              {interpolate(t.remaining, { count: COMMENT_BODY_MAX - draft.length })}
            </span>

            <Button type="submit" size="sm" loading={posting} disabled={draft.trim() === ''}>
              {t.post}
            </Button>
          </div>
        </form>
      ) : null}

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t.deleteTitle}
        description={
          deleting && me !== deleting.author.id
            ? interpolate(t.deleteOtherBody, {
                name: `${deleting.author.firstName} ${deleting.author.lastName}`,
              })
            : t.deleteBody
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {confirm.cancel}
            </Button>
            <Button onClick={() => void confirmDelete()}>{t.deleteSubmit}</Button>
          </>
        }
      />
    </div>
  );
}

/** A quiet inline action under a comment. Text, because a row of icons here would out-shout the words. */
function RowButton({
  children,
  onClick,
  tone = 'default',
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'focus-visible:outline-focus rounded-xs text-xs transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2',
        tone === 'danger'
          ? 'text-text-subtle hover:text-danger'
          : 'text-text-subtle hover:text-text',
      )}
    >
      {children}
    </button>
  );
}
