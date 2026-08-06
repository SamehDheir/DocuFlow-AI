'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { useLiveEvent } from '@/components/providers/live-provider';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, DocumentGlyph } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { relativeTime } from '@/lib/activity';
import {
  cancelApproval,
  decideApproval,
  listApprovals,
  type ApprovalRequest,
  type ApprovalScope,
  type ApprovalStatus,
} from '@/lib/approvals';
import { errorMessage } from '@/lib/error-message';
import { respectMotion, riseItem, stagger } from '@/lib/motion';

type Load = 'loading' | 'ready' | 'error';
type Tab = 'waiting' | 'raised' | 'all';

const SCOPES: Record<Tab, ApprovalScope | undefined> = {
  waiting: 'me',
  raised: 'mine',
  all: undefined,
};

const STATUS_TONES: Record<ApprovalStatus, BadgeTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

export function ApprovalsView({
  lang,
  t,
  errors,
  common,
  confirm,
}: {
  lang: Locale;
  t: Dictionary['approvals'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  confirm: Dictionary['confirm'];
}) {
  const { status, withToken, user } = useSession();
  const toast = useToast();
  const reduced = useReducedMotion();
  const variants = respectMotion(riseItem, reduced);
  const tabsId = useId();

  const [tab, setTab] = useState<Tab>('waiting');
  const [items, setItems] = useState<ApprovalRequest[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [message, setMessage] = useState('');
  const [deciding, setDeciding] = useState<{
    request: ApprovalRequest;
    decision: 'APPROVED' | 'REJECTED';
  } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * Set for any fetch after the first. The list below deliberately keeps the
   * previous tab's rows on screen while the next ones arrive, which is right —
   * but with no cue at all a slow connection looks like a tab that did not
   * respond to being pressed.
   */
  const [refetching, setRefetching] = useState(false);

  /** Bumped to refetch — by the retry button and by live approval events. */
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => {
    setRefetching(true);
    setReloadKey((key) => key + 1);
  }, []);

  /** Raises the dim before the request goes out, in the handler that causes it. */
  const selectTab = useCallback((next: Tab) => {
    setRefetching(true);
    setTab(next);
  }, []);

  /**
   * Inline rather than a `useCallback` the effect calls, so every setState
   * provably follows an await — the pattern the documents list already uses.
   *
   * Note there is no `setLoad('loading')`: switching tabs keeps the previous
   * list on screen until the new one arrives instead of flashing a skeleton,
   * and the initial 'loading' state already covers the first paint.
   */
  useEffect(() => {
    if (status !== 'authenticated') {
      return;
    }

    let current = true;

    void (async () => {
      try {
        const page = await withToken((token) => listApprovals(token, { scope: SCOPES[tab] }));

        if (!current) {
          return;
        }

        setItems(page.items);
        setCursor(page.nextCursor);
        setLoad('ready');
      } catch (error) {
        if (!current) {
          return;
        }

        setMessage(errorMessage(error, errors, common.genericError));
        setLoad('error');
      } finally {
        if (current) {
          setRefetching(false);
        }
      }
    })();

    return () => {
      current = false;
    };
  }, [status, tab, reloadKey, withToken, errors, common.genericError]);

  /**
   * A colleague deciding a request elsewhere updates this list without a
   * refresh — which matters most here, because two people acting on the same
   * queue is the normal case rather than the exception.
   */
  useLiveEvent((event) => {
    if (event.type === 'approval.changed') {
      refresh();
    }
  });

  const loadMore = async () => {
    if (!cursor) {
      return;
    }

    try {
      const page = await withToken((token) => listApprovals(token, { scope: SCOPES[tab], cursor }));
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  const submitDecision = async () => {
    if (!deciding) {
      return;
    }

    setBusy(true);

    try {
      const updated = await withToken((token) =>
        decideApproval(token, deciding.request.id, deciding.decision, note || undefined),
      );

      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));

      toast.success(
        interpolate(deciding.decision === 'APPROVED' ? t.approved : t.rejected, {
          name: deciding.request.document.name,
        }),
      );

      setDeciding(null);
      setNote('');
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (request: ApprovalRequest) => {
    try {
      const updated = await withToken((token) => cancelApproval(token, request.id));
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(t.withdrawn);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  const empty = tab === 'raised' ? t.emptyRaised : t.empty;

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <motion.header variants={variants}>
        <p className="text-text-subtle text-xs font-medium tracking-wide uppercase">{t.title}</p>
        <h1 className="font-display mt-1 text-3xl tracking-tight text-balance sm:text-4xl">
          {t.title}
        </h1>
        <p className="text-text-muted mt-2 max-w-2xl text-sm">{t.subtitle}</p>
      </motion.header>

      <motion.div variants={variants}>
        <Tabs
          idBase={tabsId}
          label={t.title}
          value={tab}
          onChange={selectTab}
          items={[
            { value: 'waiting', label: t.tabs.waiting },
            { value: 'raised', label: t.tabs.raised },
            { value: 'all', label: t.tabs.all },
          ]}
        />
      </motion.div>

      <motion.section variants={variants}>
        <TabPanel idBase={tabsId} value={tab} selected={tab}>
          {load === 'loading' ? (
            <SkeletonRegion label={t.loading} className="flex flex-col gap-3">
              {[0, 1, 2].map((index) => (
                <div key={index} className="border-border rounded-xl border p-4">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="mt-3 h-3 w-2/3" />
                </div>
              ))}
            </SkeletonRegion>
          ) : load === 'error' ? (
            <div className="border-danger-border bg-danger-subtle rounded-xl border px-6 py-10 text-center">
              <h2 className="font-display text-lg">{t.error.title}</h2>
              <p className="text-text-muted mt-2 text-sm">{message}</p>
              <Button variant="secondary" className="mt-5" onClick={refresh}>
                {t.error.retry}
              </Button>
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon={<DocumentGlyph />} title={empty.title} body={empty.body} />
          ) : (
            /*
             * Opacity only, so there is nothing to strip for reduced motion —
             * the rows stay exactly where they are and simply recede while the
             * next tab's answer is in flight.
             */
            <div
              aria-busy={refetching}
              className={refetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}
            >
              <ul className="flex flex-col gap-3">
                <AnimatePresence initial={false}>
                  {items.map((request) => (
                    <ApprovalCard
                      key={request.id}
                      request={request}
                      lang={lang}
                      t={t}
                      isRequester={request.requestedBy.id === user?.id}
                      onDecide={(decision) => {
                        setNote('');
                        setDeciding({ request, decision });
                      }}
                      onWithdraw={() => void withdraw(request)}
                    />
                  ))}
                </AnimatePresence>
              </ul>

              {cursor ? (
                <div className="mt-6 text-center">
                  <Button variant="secondary" onClick={() => void loadMore()}>
                    {t.loadMore}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </TabPanel>
      </motion.section>

      <Dialog
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={
          deciding
            ? interpolate(t.decisionTitle, {
                decision: deciding.decision === 'APPROVED' ? t.approve : t.reject,
                name: deciding.request.document.name,
              })
            : ''
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeciding(null)}>
              {confirm.cancel}
            </Button>
            <Button
              variant={deciding?.decision === 'REJECTED' ? 'secondary' : 'primary'}
              loading={busy}
              onClick={() => void submitDecision()}
            >
              {deciding?.decision === 'APPROVED' ? t.approve : t.reject}
            </Button>
          </>
        }
      >
        <Textarea
          label={t.decisionNoteLabel}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
        />
      </Dialog>
    </motion.div>
  );
}

function ApprovalCard({
  request,
  lang,
  t,
  isRequester,
  onDecide,
  onWithdraw,
}: {
  request: ApprovalRequest;
  lang: Locale;
  t: Dictionary['approvals'];
  isRequester: boolean;
  onDecide: (decision: 'APPROVED' | 'REJECTED') => void;
  onWithdraw: () => void;
}) {
  const reduced = useReducedMotion();
  const pending = request.status === 'PENDING';

  const name = (person: { firstName: string; lastName: string }) =>
    `${person.firstName} ${person.lastName}`;

  return (
    <motion.li
      layout
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="border-border bg-surface rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="latin text-text truncate text-sm font-medium">
          {request.document.name}
        </span>

        <Badge tone={STATUS_TONES[request.status]} dot>
          {t.status[request.status]}
        </Badge>

        <time
          dateTime={request.createdAt}
          title={new Date(request.createdAt).toLocaleString(lang)}
          className="text-text-subtle ms-auto text-xs"
        >
          {relativeTime(request.createdAt, lang)}
        </time>
      </div>

      <p className="text-text-muted mt-2 text-xs">
        {interpolate(t.requestedBy, { name: name(request.requestedBy) })}
        {' · '}
        {request.assignee
          ? interpolate(t.assignedTo, { name: name(request.assignee) })
          : t.openToAnyone}
      </p>

      {request.note ? (
        <p className="text-text mt-3 text-sm leading-relaxed">{request.note}</p>
      ) : null}

      {request.decisionNote ? (
        <p className="border-border text-text-muted mt-3 border-s-2 ps-3 text-sm leading-relaxed">
          {request.decisionNote}
        </p>
      ) : null}

      {request.decidedBy ? (
        <p className="text-text-subtle mt-2 text-xs">
          {interpolate(t.decidedBy, { name: name(request.decidedBy) })}
        </p>
      ) : null}

      {pending ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {/*
           * A requester never sees Approve/Reject on their own request — the
           * API refuses a self-decision, and offering a button that always
           * fails is worse than offering none.
           */}
          {isRequester ? (
            <Button size="sm" variant="ghost" onClick={onWithdraw}>
              {t.withdraw}
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => onDecide('APPROVED')}>
                {t.approve}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onDecide('REJECTED')}>
                {t.reject}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </motion.li>
  );
}
