'use client';

import { useEffect, useId, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { useLiveEvent } from '@/components/providers/live-provider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import type { Dictionary } from '@/i18n/get-dictionary';
import { getDocument, type DocumentDetail, type DocumentSummary } from '@/lib/documents';
import { DocumentBytes, ExtractedText, StageDot, Summary } from './document-panels';

type Tab = 'preview' | 'text' | 'summary';

/**
 * Quick look at a document without leaving the list.
 *
 * The bytes come through the API rather than a storage URL, for the same reason
 * downloads do — the API issues no presigned URLs, so every read stays behind
 * the same permission check. That means the file arrives as a blob and is shown
 * from an object URL, which has to be revoked or it pins the whole file in
 * memory for the life of the tab.
 */
export function DocumentPreview({
  item,
  onClose,
  t,
  errors,
  common,
  onDownload,
}: {
  /** null closes the dialog; a document opens it. */
  item: DocumentSummary | null;
  onClose: () => void;
  t: Dictionary['documents'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  onDownload: (item: DocumentSummary) => void;
}) {
  const { withToken } = useSession();

  const [tab, setTab] = useState<Tab>('preview');
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const tabsId = useId();

  /**
   * Bumped to refetch. A counter rather than calling a loader directly, so the
   * live handler below stays a plain state update and the fetch itself lives in
   * one effect — every setState then happens after an await, never
   * synchronously in the effect body.
   */
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * The detail request is what carries `extractedText` and `summary`. The list
   * endpoint deliberately omits both — a page of scanned contracts would be
   * megabytes — so opening a document is where they are fetched.
   */
  useEffect(() => {
    if (!item) {
      return;
    }

    let current = true;

    void (async () => {
      try {
        const fresh = await withToken((token) => getDocument(token, item.id));

        if (current) {
          setDetail(fresh);
        }
      } catch {
        // The preview itself still works; the tabs show their empty state.
      }
    })();

    return () => {
      current = false;
    };
  }, [item, withToken, reloadKey]);

  /**
   * A document opened while it is still processing fills in as the worker
   * finishes, without the user reopening it — which is the whole reason the
   * event stream exists.
   */
  useLiveEvent((event) => {
    if (event.type === 'document.status' && event.documentId === item?.id) {
      setReloadKey((key) => key + 1);
    }
  });

  if (!item) return null;

  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      title={item.name}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.preview.close}
          </Button>
          <Button onClick={() => onDownload(item)}>{t.actions.download}</Button>
        </>
      }
    >
      <Tabs
        idBase={tabsId}
        label={item.name}
        value={tab}
        onChange={setTab}
        className="mb-4"
        items={[
          { value: 'preview', label: t.processing.tabs.preview },
          {
            value: 'text',
            label: t.processing.tabs.text,
            badge: <StageDot stage={detail?.metadata?.ocrStatus} />,
          },
          {
            value: 'summary',
            label: t.processing.tabs.summary,
            badge: <StageDot stage={detail?.metadata?.aiStatus} />,
          },
        ]}
      />

      <TabPanel idBase={tabsId} value="text" selected={tab}>
        <ExtractedText detail={detail} t={t} />
      </TabPanel>

      <TabPanel idBase={tabsId} value="summary" selected={tab}>
        <Summary detail={detail} t={t} />
      </TabPanel>

      <TabPanel idBase={tabsId} value="preview" selected={tab}>
        <DocumentBytes
          item={item}
          detail={detail}
          t={t}
          errors={errors}
          common={common}
          onDownload={() => onDownload(item)}
        />
      </TabPanel>
    </Dialog>
  );
}

/*
 * There is deliberately no `canPreview` gate here.
 *
 * The preview is offered for every document — a button that appears and
 * disappears by file type reads as broken — and since v2 there is always
 * something to show: the rendered bytes when a browser can display them, and
 * the extracted text when it cannot.
 */
