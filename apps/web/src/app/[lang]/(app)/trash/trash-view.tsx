'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { BulkBar, type BulkOutcome } from '@/components/documents/bulk-bar';
import { DocumentRow } from '@/components/documents/document-row';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { PageHeader } from '@/components/ui/page-header';
import { DocumentGlyph, EmptyState } from '@/components/ui/empty-state';
import { SkeletonRegion, SkeletonRows } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { fetchProfile } from '@/lib/auth';
import {
  bulkRestore,
  listDocuments,
  restoreDocument,
  MAX_BULK_IDS,
  type DocumentSummary,
} from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { respectMotion, riseItem, stagger } from '@/lib/motion';

type Load = 'loading' | 'ready' | 'error';

export function TrashView({
  lang,
  t,
  tDocuments,
  tBulk,
  errors,
  common,
}: {
  lang: Locale;
  t: Dictionary['trash'];
  tDocuments: Dictionary['documents'];
  tBulk: Dictionary['bulk'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
}) {
  const { status, withToken } = useSession();
  const toast = useToast();
  const reduced = useReducedMotion();

  const [load, setLoad] = useState<Load>('loading');
  const [message, setMessage] = useState('');
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [attempt, setAttempt] = useState(0);

  /**
   * Restore is the ONLY batch offered here.
   *
   * `documents/bulk/delete` soft-deletes, so on rows that are already in the
   * trash every id would come back skipped — an action whose entire result is a
   * list of refusals. Emptying the trash for good is a hard delete the API does
   * not have, and inventing one in the UI is not something a button can do.
   */
  const [canRestore, setCanRestore] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        const page = await withToken((token) => listDocuments(token, { trash: true }));
        if (!current) return;

        setDocuments(page.items);
        setSelected([]);
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
  }, [status, withToken, attempt, errors, common.genericError]);

  /**
   * Separate from the document load so a failed profile read leaves the trash
   * itself readable — the checkboxes simply do not appear, and the API refuses
   * anything reached without the permission regardless.
   */
  useEffect(() => {
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        const profile = await withToken(fetchProfile);
        if (current) setCanRestore(profile.permissions.includes('documents.restore'));
      } catch {
        if (current) setCanRestore(false);
      }
    })();

    return () => {
      current = false;
    };
  }, [status, withToken]);

  const restore = async (item: DocumentSummary) => {
    try {
      await withToken((token) => restoreDocument(token, item.id));
      // Removed locally rather than refetched: the row leaving the list IS the
      // confirmation, and a refetch would make it linger for a round trip.
      setDocuments((current) => current.filter((entry) => entry.id !== item.id));
      toast.success(interpolate(t.restored, { name: item.name }));
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  const restoreSelected = async () => {
    if (selected.length === 0 || busy) return;

    setBusy('restore');
    setOutcome(null);

    try {
      const result = await withToken((token) => bulkRestore(token, selected));

      setOutcome({ action: 'restore', result });
      // Only the ones that actually came back leave the list. A skipped id is
      // still in the trash, and dropping it would hide the row the report is
      // about.
      const restored = new Set(result.succeeded);
      setDocuments((current) => current.filter((entry) => !restored.has(entry.id)));
      setSelected([]);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setBusy(null);
    }
  };

  const allSelected = documents.length > 0 && selected.length === documents.length;

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <PageHeader
        variants={respectMotion(riseItem, reduced)}
        eyebrow={t.title}
        title={t.title}
        description={t.subtitle}
      />

      <motion.section variants={respectMotion(riseItem, reduced)}>
        {load === 'loading' ? (
          <SkeletonRegion
            label={tDocuments.loading}
            className="border-border bg-surface rounded-xl border"
          >
            <SkeletonRows rows={3} />
          </SkeletonRegion>
        ) : null}

        {load === 'error' ? (
          <div className="border-danger-border bg-danger-subtle rounded-xl border px-6 py-10 text-center">
            <h2 className="font-display text-lg">{tDocuments.error.title}</h2>
            <p className="text-text-muted mt-2 text-sm">{message}</p>
            <Button
              variant="secondary"
              className="mt-5"
              onClick={() => {
                setLoad('loading');
                setAttempt((value) => value + 1);
              }}
            >
              {tDocuments.error.retry}
            </Button>
          </div>
        ) : null}

        {load === 'ready' && documents.length === 0 ? (
          <EmptyState icon={<DocumentGlyph />} title={t.empty.title} body={t.empty.body} />
        ) : null}

        {load === 'ready' && documents.length > 0 ? (
          <div className="border-border bg-surface overflow-hidden rounded-xl border">
            {canRestore ? (
              <div className="border-border border-b px-4 py-2">
                <Checkbox
                  label={tDocuments.selection.all}
                  hideLabel
                  checked={allSelected}
                  indeterminate={selected.length > 0 && !allSelected}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? documents.slice(0, MAX_BULK_IDS).map((item) => item.id)
                        : [],
                    )
                  }
                />
              </div>
            ) : null}

            <div className="divide-border divide-y">
              {documents.map((item) => (
                <DocumentRow
                  key={item.id}
                  item={item}
                  locale={lang}
                  t={tDocuments}
                  actions={[
                    { key: 'restore', label: t.restore, onSelect: () => void restore(item) },
                  ]}
                  selected={selected.includes(item.id)}
                  select={
                    canRestore ? (
                      <Checkbox
                        label={interpolate(tDocuments.selection.row, { name: item.name })}
                        hideLabel
                        checked={selected.includes(item.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, item.id]
                              : current.filter((entry) => entry !== item.id),
                          )
                        }
                      />
                    ) : null
                  }
                />
              ))}
            </div>
          </div>
        ) : null}

        <BulkBar
          count={selected.length}
          actions={[
            { key: 'restore', label: tBulk.restore, onSelect: () => void restoreSelected() },
          ]}
          busy={busy}
          outcome={outcome}
          onDismiss={() => setOutcome(null)}
          onClear={() => setSelected([])}
          t={tBulk}
          errors={errors}
          common={common}
        />
      </motion.section>
    </motion.div>
  );
}
