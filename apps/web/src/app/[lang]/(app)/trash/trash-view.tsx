'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { DocumentRow } from '@/components/documents/document-row';
import { Button } from '@/components/ui/button';
import { DocumentGlyph, EmptyState } from '@/components/ui/empty-state';
import { SkeletonRegion, SkeletonRows } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { listDocuments, restoreDocument, type DocumentSummary } from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { respectMotion, riseItem, stagger } from '@/lib/motion';

type Load = 'loading' | 'ready' | 'error';

export function TrashView({
  lang,
  t,
  tDocuments,
  errors,
  common,
}: {
  lang: Locale;
  t: Dictionary['trash'];
  tDocuments: Dictionary['documents'];
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

  useEffect(() => {
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        const page = await withToken((token) => listDocuments(token, { trash: true }));
        if (!current) return;

        setDocuments(page.items);
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

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <motion.header variants={respectMotion(riseItem, reduced)}>
        <p className="text-text-subtle text-xs font-medium tracking-wide uppercase">{t.title}</p>
        <h1 className="font-display mt-1 text-3xl sm:text-4xl">{t.title}</h1>
        <p className="text-text-muted mt-2 text-sm">{t.subtitle}</p>
      </motion.header>

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
          <div className="border-border bg-surface divide-border divide-y overflow-hidden rounded-xl border">
            {documents.map((item) => (
              <DocumentRow
                key={item.id}
                item={item}
                locale={lang}
                t={tDocuments}
                actions={[{ key: 'restore', label: t.restore, onSelect: () => void restore(item) }]}
              />
            ))}
          </div>
        ) : null}
      </motion.section>
    </motion.div>
  );
}
