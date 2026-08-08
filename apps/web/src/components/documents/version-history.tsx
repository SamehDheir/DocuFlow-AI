'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useRef, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { useToast } from '@/components/ui/toast';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import {
  addVersion,
  fetchVersionBlob,
  formatBytes,
  revertToVersion,
  type DocumentDetail,
  type DocumentVersion,
} from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { DURATION, EASE } from '@/lib/motion';

/**
 * A document's history, and the two ways to add to it.
 *
 * NOTHING HERE REWINDS. Uploading a replacement appends; so does reverting — the
 * old bytes are copied to a fresh storage key and become version N+1. That is
 * why the list only ever grows, and why the version someone reverted away from
 * is still sitting in it. A history that can lose entries is not a history, and
 * "who changed this file, and can we get it back" is the question the product
 * exists to answer.
 *
 * Both writes need `documents.create` AND `documents.update` — it is an upload
 * and a rewrite of what every colleague sees, and neither authority alone should
 * be enough. The caller passes `canWrite` having checked both.
 */
export function VersionHistory({
  detail,
  locale,
  t,
  errors,
  common,
  confirm,
  canWrite,
  onChanged,
}: {
  detail: DocumentDetail;
  locale: Locale;
  t: Dictionary['documents'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  confirm: Dictionary['confirm'];
  canWrite: boolean;
  /** Refetches the document — the version list and the parent row both moved. */
  onChanged: () => void;
}) {
  const { withToken } = useSession();
  const toast = useToast();
  const reduced = useReducedMotion();

  const [uploading, setUploading] = useState(false);
  const [reverting, setReverting] = useState<DocumentVersion | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Archive is read-only for anything that changes what the document IS, which
   * includes both of these. Refusing here rather than letting the API 409 keeps
   * the reason visible next to the control instead of arriving as a toast after
   * the file has been chosen.
   */
  const frozen = detail.status === 'ARCHIVED';
  const writable = canWrite && !frozen;

  const closeUpload = () => {
    setUploading(false);
    setFile(null);
    setNote('');
  };

  const submitUpload = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!file) {
      return;
    }

    setBusy(true);

    try {
      await withToken((token) => addVersion(token, detail.id, file, note.trim() || undefined));
      closeUpload();
      onChanged();
      toast.success(t.versions.uploaded);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setBusy(false);
    }
  };

  const submitRevert = async () => {
    if (!reverting) {
      return;
    }

    setBusy(true);

    try {
      await withToken((token) =>
        revertToVersion(token, detail.id, reverting.id, note.trim() || undefined),
      );

      toast.success(interpolate(t.versions.reverted, { version: String(reverting.versionNumber) }));
      setReverting(null);
      setNote('');
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setBusy(false);
    }
  };

  const download = async (version: DocumentVersion) => {
    try {
      const url = await withToken((token) => fetchVersionBlob(token, detail.id, version.id));
      const anchor = document.createElement('a');

      anchor.href = url;
      anchor.download = version.originalName;
      anchor.click();

      // Next tick: immediately would race the click, never would pin the blob.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  // Newest first, which is how the API returns them — spelled out so a change
  // there cannot silently invert the reading order.
  const versions = [...detail.versions].sort((a, b) => b.versionNumber - a.versionNumber);
  const current = versions[0]?.id;

  return (
    <div className="flex flex-col gap-4">
      {writable ? (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => setUploading(true)}>
            {t.versions.upload}
          </Button>
        </div>
      ) : null}

      {frozen && canWrite ? <p className="text-text-subtle text-xs">{t.versions.frozen}</p> : null}

      <ol className="flex flex-col">
        <AnimatePresence initial={false}>
          {versions.map((version, index) => (
            <motion.li
              key={version.id}
              layout={!reduced}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DURATION.base, ease: EASE.outQuint }}
              className="relative flex gap-3 ps-1"
            >
              {/*
                The spine. Drawn per row rather than as one absolute element so
                it stops at the last entry instead of running past it, and
                hidden on the last row entirely.
              */}
              {index < versions.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="bg-border absolute inset-s-[1.375rem] top-8 bottom-0 w-px"
                />
              ) : null}

              <Avatar
                firstName={version.uploadedBy.firstName}
                lastName={version.uploadedBy.lastName}
                size="sm"
                tone={version.id === current ? 'accent' : 'neutral'}
                className="z-10 mt-1"
              />

              <div className="min-w-0 flex-1 pb-5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">
                    {interpolate(t.versions.label, { version: String(version.versionNumber) })}
                  </span>

                  {version.id === current ? (
                    <Badge tone="accent">{t.versions.current}</Badge>
                  ) : null}

                  <span className="text-text-subtle text-xs">
                    {formatBytes(version.size, locale)}
                  </span>
                </div>

                <p className="text-text-muted mt-0.5 text-xs">
                  {interpolate(t.versions.by, {
                    name: `${version.uploadedBy.firstName} ${version.uploadedBy.lastName}`,
                    date: new Intl.DateTimeFormat(locale, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(version.createdAt)),
                  })}
                </p>

                {/*
                  The filename is repeated per version because it can change
                  between them — a .docx replaced by a .pdf is the case the
                  schema carries this column for.
                */}
                <p className="latin text-text-subtle mt-0.5 truncate text-xs">
                  {version.originalName}
                </p>

                {version.note ? (
                  <p className="text-text mt-1.5 text-sm text-pretty">{version.note}</p>
                ) : null}

                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={() => void download(version)}>
                    {t.actions.download}
                  </Button>

                  {writable && version.id !== current ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setNote('');
                        setReverting(version);
                      }}
                    >
                      {t.versions.revert}
                    </Button>
                  ) : null}
                </div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>

      <Dialog
        open={uploading}
        onClose={closeUpload}
        title={t.versions.upload}
        description={t.versions.uploadHint}
        footer={
          <>
            <Button variant="ghost" onClick={closeUpload} disabled={busy}>
              {confirm.cancel}
            </Button>
            <Button
              type="submit"
              form="add-version"
              loading={busy}
              disabled={!file}
              onClick={(event) => {
                // The submit button lives in the dialog footer, outside the
                // form element — `form=` associates them, and this is the
                // fallback for the one browser generation that ignores it.
                if (!file) event.preventDefault();
              }}
            >
              {t.versions.upload}
            </Button>
          </>
        }
      >
        <form
          id="add-version"
          onSubmit={(event) => void submitUpload(event)}
          className="grid gap-4"
        >
          <div>
            <label
              htmlFor="version-file"
              className="text-text-muted mb-1.5 block text-xs font-medium"
            >
              {t.versions.file}
            </label>
            <input
              ref={fileInput}
              id="version-file"
              type="file"
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="border-border bg-surface-inset text-text file:bg-surface file:text-text file:border-border w-full rounded-lg border px-3 py-2.5 text-sm file:me-3 file:rounded-md file:border file:px-3 file:py-1 file:text-xs"
            />
          </div>

          <TextField
            label={t.versions.note}
            hint={t.versions.noteHint}
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </form>
      </Dialog>

      <Dialog
        open={reverting !== null}
        onClose={() => setReverting(null)}
        title={t.versions.revert}
        description={
          reverting
            ? interpolate(t.versions.revertBody, { version: String(reverting.versionNumber) })
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setReverting(null)} disabled={busy}>
              {confirm.cancel}
            </Button>
            <Button loading={busy} onClick={() => void submitRevert()}>
              {t.versions.revertSubmit}
            </Button>
          </>
        }
      >
        <TextField
          label={t.versions.note}
          hint={t.versions.noteHint}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
      </Dialog>
    </div>
  );
}
