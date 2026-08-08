import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DocumentStatus } from '@prisma/client';
import type { AuditService } from '../common/audit/audit.service';
import type { Env } from '../config/env.validation';
import type { NotificationsService } from '../notifications/notifications.service';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import type { DocumentProcessingProducer } from '../queue/document-processing.producer';
import type { StorageService } from '../storage/storage.service';
import { DocumentsService, type UploadedFile } from './documents.service';
import { DocumentStatusFilter } from './dto/list-documents.dto';

const COMPANY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const USER = 'b1a7f4c2-0000-4000-8000-000000000001';
const CONTEXT = { ipAddress: '127.0.0.1', userAgent: 'jest' };

const ENV: Partial<Env> = {
  MAX_FILE_SIZE: 1024,
  // text/plain is here on purpose: it is accepted for upload but is NOT in the
  // inline-previewable set, which is what the preview tests below rely on.
  ALLOWED_MIME_TYPES: [
    'application/pdf',
    'image/png',
    'text/plain',
    // Accepted for upload but not renderable in a browser — the case that
    // proves inline preview is a narrower allowlist than upload.
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
};

interface DocRow {
  id: string;
  name: string;
  originalName: string;
  mimeType: string;
  extension: string;
  size: bigint;
  storageKey: string;
  hash: string | null;
  status: DocumentStatus;
  folderId: string | null;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface VersionRow {
  id: string;
  documentId: string;
  versionNumber: number;
  storageKey: string;
  size: bigint;
  hash: string | null;
  mimeType: string;
  originalName: string;
  note: string | null;
  uploadedById: string;
  createdAt: Date;
}

/**
 * In-memory client, in the style of token.service.spec.ts. Reads return copies
 * so an update cannot mutate a snapshot the service is still holding.
 *
 * Versions are modelled through the DOCUMENT delegate, matching how the service
 * reaches them: DocumentVersion carries no companyId, so the real guard leaves a
 * direct query unfiltered and the service always goes through the parent. A
 * fake that offered a convenient `documentVersion.findFirst` would let a spec
 * pass against code the tenant guard would not protect.
 */
function createDb() {
  const documents: DocRow[] = [];
  const folders: { id: string }[] = [];
  const versions: VersionRow[] = [];

  const copy = <T>(row: T): T => ({ ...row });

  const matches = (row: object, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([field, expected]) => {
      const actual = (row as Record<string, unknown>)[field];

      if (expected && typeof expected === 'object') {
        if ('not' in expected) return actual !== expected.not;
        if ('contains' in expected) {
          return String(actual).toLowerCase().includes(String(expected.contains).toLowerCase());
        }
      }

      return actual === expected;
    });

  /** Resolves a `select.versions` clause against the version table. */
  const selectVersions = (
    documentId: string,
    clause: { where?: { id?: string }; orderBy?: unknown; take?: number },
  ): VersionRow[] => {
    let rows = versions.filter((version) => version.documentId === documentId);

    if (clause.where?.id) {
      rows = rows.filter((version) => version.id === clause.where?.id);
    }

    // Every caller orders by versionNumber desc; nothing needs the general case.
    rows = [...rows].sort((a, b) => b.versionNumber - a.versionNumber);

    return (clause.take ? rows.slice(0, clause.take) : rows).map(copy);
  };

  /**
   * Applies the parts of a `select` these specs actually depend on.
   *
   * `favorites` and `tags` are answered with empty arrays rather than modelled:
   * this fake has no rows for either, and a relation filter (`{ some: { … } }`)
   * is the kind of thing a hand-written fake gets subtly wrong. The star, the
   * chips, and the `?favorite=` / `?tagId=` filters are covered end to end
   * instead, against the real query.
   *
   * They are answered at all — rather than left off — because the service
   * flattens both unconditionally, so an absent array is a TypeError rather than
   * a missing field. That is the failure mode worth keeping: a projection that
   * grows a join and forgets to select it should break here, loudly.
   */
  const projected = (row: DocRow, select?: Record<string, unknown>) => {
    const clause = select?.versions as
      { where?: { id?: string }; orderBy?: unknown; take?: number } | undefined;

    return {
      ...copy(row),
      ...(clause ? { versions: selectVersions(row.id, clause) } : {}),
      ...(select?.favorites ? { favorites: [] } : {}),
      ...(select?.tags ? { tags: [] } : {}),
    };
  };

  const document = {
    create: ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        ...data,
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as unknown as DocRow;
      documents.push(row);
      return Promise.resolve(copy(row));
    },
    findFirst: ({
      where,
      select,
    }: {
      where?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      const row = documents.find((candidate) => matches(candidate, where));
      return Promise.resolve(row ? projected(row, select) : null);
    },
    findMany: ({
      where,
      select,
      take,
    }: {
      where?: Record<string, unknown>;
      select?: Record<string, unknown>;
      take?: number;
    }) =>
      Promise.resolve(
        documents
          .filter((row) => matches(row, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take)
          .map((row) => projected(row, select)),
      ),
    update: ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<DocRow> & {
        versions?: { create?: Omit<VersionRow, 'id' | 'documentId' | 'createdAt'> };
        metadata?: unknown;
      };
    }) => {
      const row = documents.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('not found');

      /**
       * Nested writes are applied by hand: the real client resolves these
       * relations, and the service uses them precisely because going through
       * the scoped parent is what keeps the tenant filter on.
       *
       * `metadata` is dropped rather than modelled — nothing in these specs
       * reads OCR or AI state, and the upsert shape would be pure ceremony.
       */
      const { versions: nested, ...rest } = data;
      const { metadata, ...scalars } = rest;
      void metadata;

      if (nested?.create) {
        versions.push({
          ...nested.create,
          id: randomUUID(),
          documentId: where.id,
          createdAt: new Date(),
        });
      }

      Object.assign(row, scalars, { updatedAt: new Date() });
      return Promise.resolve(copy(row));
    },
    count: ({ where }: { where?: Record<string, unknown> }) =>
      Promise.resolve(documents.filter((row) => matches(row, where)).length),
    aggregate: ({ where }: { where?: Record<string, unknown> }) =>
      Promise.resolve({
        _sum: {
          size: documents
            .filter((row) => matches(row, where))
            .reduce((total, row) => total + row.size, BigInt(0)),
        },
      }),
  };

  const db = {
    document,
    folder: {
      findFirst: ({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(folders.find((row) => matches(row, where)) ?? null),
    },
    /**
     * Only `create`, and only because the v1 upload path still writes version 1
     * this way. Every v4 read and write goes through the document delegate.
     */
    documentVersion: {
      create: ({ data }: { data: Omit<VersionRow, 'id' | 'createdAt'> }) => {
        const row = { ...data, id: randomUUID(), createdAt: new Date() };
        versions.push(row);
        return Promise.resolve(row);
      },
    },
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };

  return { db, documents, folders, versions };
}

interface StorageMock {
  putFile: jest.Mock;
  getStream: jest.Mock;
  removeQuietly: jest.Mock;
  copyObject: jest.Mock;
}

async function setup(storageOverrides: Partial<StorageMock> = {}) {
  const { db, documents, folders, versions } = createDb();
  // Concrete mock shapes rather than the service types, so assertions read a
  // jest.Mock instead of an unbound class method.
  const audit: { record: jest.Mock } = { record: jest.fn().mockResolvedValue(undefined) };
  const storage: StorageMock = {
    putFile: jest.fn().mockResolvedValue(undefined),
    getStream: jest.fn().mockResolvedValue({ pipe: jest.fn() }),
    removeQuietly: jest.fn().mockResolvedValue(undefined),
    copyObject: jest.fn().mockResolvedValue(undefined),
    ...storageOverrides,
  };

  const config = {
    get: (key: keyof Env) => ENV[key],
  } as unknown as ConfigService<Env, true>;

  /**
   * The queue is stubbed rather than run. These specs are about the upload
   * pipeline's own ordering and failure handling; whether a job is later picked
   * up is the worker's business and needs a live Redis, which belongs in e2e.
   */
  const processing: { enqueue: jest.Mock; forget: jest.Mock } = {
    enqueue: jest.fn().mockResolvedValue(true),
    forget: jest.fn().mockResolvedValue(undefined),
  };

  /**
   * Notifications are stubbed for the same reason as the queue: who gets told
   * about a new version is asserted where the recipient rules live, not in the
   * specs about upload ordering and storage failure handling.
   */
  const notifications: { create: jest.Mock } = {
    create: jest.fn().mockResolvedValue(undefined),
  };

  const service = new DocumentsService(
    db as unknown as TenantGuardedClient,
    storage as unknown as StorageService,
    audit as unknown as AuditService,
    processing as unknown as DocumentProcessingProducer,
    notifications as unknown as NotificationsService,
    config,
  );

  const dir = await mkdtemp(join(tmpdir(), 'docuflow-spec-'));

  return {
    service,
    audit,
    storage,
    processing,
    notifications,
    db,
    documents,
    folders,
    versions,
    dir,
  };
}

/**
 * Stands in for the worker finishing.
 *
 * `upload` deliberately leaves the document at PROCESSING, and archive refuses
 * anything a worker still holds — so any archive test has to get the document
 * to a settled state first.
 */
function settle(documents: DocRow[], id: string): void {
  const row = documents.find((candidate) => candidate.id === id);

  if (!row) {
    throw new Error(`no document ${id} to settle`);
  }

  row.status = DocumentStatus.READY;
}

/**
 * Upload and then settle — the starting point for anything that writes to an
 * existing document, since a new version, a revert and an archive are all
 * refused while a worker still holds it.
 */
async function uploadSettled(
  service: DocumentsService,
  documents: DocRow[],
  dir: string,
  options?: { name?: string; type?: string; bytes?: string },
) {
  const uploaded = await service.upload(await fakeUpload(dir, options), {}, USER, CONTEXT, COMPANY);
  settle(documents, uploaded.id);

  return uploaded;
}

/** Writes a temp file that stands in for what multer would have produced. */
async function fakeUpload(
  dir: string,
  { name = 'report.pdf', type = 'application/pdf', bytes = 'hello' } = {},
): Promise<UploadedFile> {
  const path = join(dir, randomUUID());
  await writeFile(path, bytes);

  return { originalname: name, mimetype: type, size: bytes.length, path };
}

describe('DocumentsService', () => {
  describe('upload', () => {
    it('stores the file, marks it PROCESSING and writes version 1', async () => {
      const { service, storage, versions, dir } = await setup();
      const file = await fakeUpload(dir);

      const document = await service.upload(file, {}, USER, CONTEXT, COMPANY);

      /**
       * PROCESSING, not READY. v1 finished the upload here; v2 hands off to the
       * queue, and only the worker declares a document READY once OCR and AI
       * analysis have run.
       */
      expect(document.status).toBe(DocumentStatus.PROCESSING);
      expect(storage.putFile).toHaveBeenCalledTimes(1);
      expect(versions).toEqual([expect.objectContaining({ versionNumber: 1 })]);
    });

    it('queues processing with the tenant from the token, after the commit', async () => {
      const { service, processing, dir } = await setup();

      const document = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      /**
       * The job has to carry its own companyId: a worker runs outside any
       * request, so there is no JWT for the tenant guard to read and an
       * unaccompanied job would fail closed on its first query.
       */
      expect(processing.enqueue).toHaveBeenCalledWith({
        documentId: document.id,
        companyId: COMPANY,
        userId: USER,
      });
    });

    it('still returns the document when the queue is unreachable', async () => {
      const { service, processing, dir } = await setup();
      processing.enqueue.mockResolvedValue(false);

      const document = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      /**
       * The bytes are in MinIO and the row is committed, so the upload
       * succeeded. It sits at PROCESSING until someone reprocesses it — which
       * is visible and recoverable, unlike reporting a stored file as failed.
       */
      expect(document.status).toBe(DocumentStatus.PROCESSING);
    });

    it('derives the storage key server-side, under the company prefix', async () => {
      const { service, documents, dir } = await setup();

      await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      expect(documents[0].storageKey).toMatch(
        new RegExp(`^documents/company_${COMPANY}/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.pdf$`),
      );
    });

    it('serialises size as a string, because BigInt does not survive JSON', async () => {
      const { service, dir } = await setup();

      const document = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      expect(document.size).toBe('5');
      expect(typeof document.size).toBe('string');
    });

    it('rejects a MIME type outside the allowlist', async () => {
      const { service, storage, dir } = await setup();
      const file = await fakeUpload(dir, { type: 'application/x-msdownload' });

      await expect(service.upload(file, {}, USER, CONTEXT, COMPANY)).rejects.toThrow(
        /not accepted/,
      );
      expect(storage.putFile).not.toHaveBeenCalled();
    });

    it('rejects a file over the size limit', async () => {
      const { service, dir } = await setup();
      const file = await fakeUpload(dir, { bytes: 'x'.repeat(2048) });

      await expect(service.upload(file, {}, USER, CONTEXT, COMPANY)).rejects.toThrow(
        /MB or smaller/,
      );
    });

    it('404s when the target folder is not in this tenant', async () => {
      const { service, dir } = await setup();

      await expect(
        service.upload(await fakeUpload(dir), { folderId: randomUUID() }, USER, CONTEXT, COMPANY),
      ).rejects.toThrow(/folder does not exist/);
    });

    it('deletes the temp file even when the upload fails', async () => {
      // Otherwise a rejected upload fills the disk one attempt at a time.
      const { service, dir } = await setup({
        putFile: jest.fn().mockRejectedValue(new Error('minio down')),
      });
      const file = await fakeUpload(dir);

      await expect(service.upload(file, {}, USER, CONTEXT, COMPANY)).rejects.toThrow('minio down');
      await expect(readdir(dir)).resolves.toEqual([]);
    });

    it('leaves the row at UPLOADING when storage fails, rather than orphaning it', async () => {
      // A visible, sweepable state beats a row claiming READY over bytes that
      // were never written.
      const { service, documents, dir } = await setup({
        putFile: jest.fn().mockRejectedValue(new Error('minio down')),
      });

      await expect(
        service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY),
      ).rejects.toThrow();

      expect(documents).toHaveLength(1);
      expect(documents[0].status).toBe(DocumentStatus.UPLOADING);
    });

    it('records an audit row', async () => {
      const { service, audit, dir } = await setup();

      await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'document.upload' }),
        expect.anything(),
      );
    });
  });

  describe('soft delete', () => {
    it('keeps the row and the bytes, flipping deletedAt and status', async () => {
      const { service, documents, storage, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      await service.remove(uploaded.id, CONTEXT);

      expect(documents).toHaveLength(1);
      expect(documents[0].deletedAt).toBeInstanceOf(Date);
      expect(documents[0].status).toBe(DocumentStatus.DELETED);
      // Restore is a v1 feature, so the object must survive the delete.
      expect(storage.removeQuietly).not.toHaveBeenCalled();
    });

    it('hides a deleted document from the default listing', async () => {
      // The tenant guard filters companyId and nothing else — deletedAt is the
      // service's job, and this is the assertion that keeps it honest.
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      await service.remove(uploaded.id, CONTEXT);

      const { items } = await service.list({}, USER);

      expect(items).toEqual([]);
    });

    it('shows it in the trash listing instead', async () => {
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      await service.remove(uploaded.id, CONTEXT);

      const { items } = await service.list({ trash: 'true' }, USER);

      expect(items.map((item) => item.id)).toEqual([uploaded.id]);
    });

    it('404s a second delete of the same document', async () => {
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      await service.remove(uploaded.id, CONTEXT);

      await expect(service.remove(uploaded.id, CONTEXT)).rejects.toThrow(/does not exist/);
    });

    it('excludes deleted documents from the dashboard totals', async () => {
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      await service.remove(uploaded.id, CONTEXT);

      await expect(service.stats()).resolves.toEqual({
        documents: 0,
        storageBytes: '0',
        trashed: 1,
      });
    });
  });

  describe('restore', () => {
    it('brings a document back to READY', async () => {
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      await service.remove(uploaded.id, CONTEXT);

      const restored = await service.restore(uploaded.id, CONTEXT);

      expect(restored.deletedAt).toBeNull();
      expect(restored.status).toBe(DocumentStatus.READY);
    });

    it('refuses to restore something that was never deleted', async () => {
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      await expect(service.restore(uploaded.id, CONTEXT)).rejects.toThrow(/not in the trash/);
    });
  });

  describe('preview', () => {
    it('refuses to render a type no browser can display', async () => {
      /**
       * A .docx streamed inline would just download, so the preview pane asks
       * for nothing and renders the extracted text instead. Refusing here keeps
       * the server authoritative if the client's mirrored allowlist drifts.
       */
      const { service, dir } = await setup();
      const file = await fakeUpload(dir, {
        name: 'report.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const uploaded = await service.upload(file, {}, USER, CONTEXT, COMPANY);

      await expect(service.openForDownload(uploaded.id, CONTEXT, { inline: true })).rejects.toThrow(
        /cannot be previewed/,
      );
    });

    it('renders text/plain inline, hardened by the response headers', async () => {
      /**
       * Safe despite being user-supplied bytes in our own origin: the controller
       * sets `X-Content-Type-Options: nosniff` so a browser cannot re-interpret
       * it as HTML, and `Content-Security-Policy: sandbox; default-src 'none'`
       * neuters anything that survives. The web additionally re-wraps the blob
       * with a type from its own allowlist rather than trusting the response.
       */
      const { service, dir } = await setup();
      const file = await fakeUpload(dir, { name: 'notes.txt', type: 'text/plain' });
      const uploaded = await service.upload(file, {}, USER, CONTEXT, COMPANY);

      const { document } = await service.openForDownload(uploaded.id, CONTEXT, { inline: true });

      expect(document.mimeType).toBe('text/plain');
    });

    it('still allows that type to be downloaded as an attachment', async () => {
      const { service, dir } = await setup();
      const file = await fakeUpload(dir, { name: 'notes.txt', type: 'text/plain' });
      const uploaded = await service.upload(file, {}, USER, CONTEXT, COMPANY);

      await expect(
        service.openForDownload(uploaded.id, CONTEXT, { inline: false }),
      ).resolves.toBeDefined();
    });

    it('renders a PDF inline', async () => {
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      await expect(
        service.openForDownload(uploaded.id, CONTEXT, { inline: true }),
      ).resolves.toBeDefined();
    });

    it('404s a download of a trashed document', async () => {
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      await service.remove(uploaded.id, CONTEXT);

      await expect(
        service.openForDownload(uploaded.id, CONTEXT, { inline: false }),
      ).rejects.toThrow(/does not exist/);
    });
  });

  describe('addVersion', () => {
    it('numbers from the current maximum rather than a literal', async () => {
      const { service, documents, versions, dir } = await setup();
      const uploaded = await uploadSettled(service, documents, dir);

      await service.addVersion(uploaded.id, await fakeUpload(dir), {}, USER, COMPANY, CONTEXT);
      settle(documents, uploaded.id);
      await service.addVersion(uploaded.id, await fakeUpload(dir), {}, USER, COMPANY, CONTEXT);

      expect(versions.map((version) => version.versionNumber)).toEqual([1, 2, 3]);
    });

    /**
     * A new version is refused while a worker still holds the document, for the
     * same reason a reprocess is: two runs would interleave on one metadata row.
     */
    it('refuses while the document is still being processed', async () => {
      const { service, dir } = await setup();
      // upload leaves it at PROCESSING, deliberately unsettled here.
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      await expect(
        service.addVersion(uploaded.id, await fakeUpload(dir), {}, USER, COMPANY, CONTEXT),
      ).rejects.toThrow(/already being processed/);
    });

    it('repoints the document at the new bytes', async () => {
      const { service, documents, versions, dir } = await setup();
      const uploaded = await uploadSettled(service, documents, dir);
      const first = documents[0].storageKey;

      await service.addVersion(
        uploaded.id,
        await fakeUpload(dir, { name: 'revised.pdf', bytes: 'longer contents' }),
        { note: 'second draft' },
        USER,
        COMPANY,
        CONTEXT,
      );

      const row = documents[0];

      expect(row.storageKey).not.toBe(first);
      expect(row.originalName).toBe('revised.pdf');
      expect(row.size).toBe(BigInt('longer contents'.length));
      // Back to the pipeline: the bytes changed, so the stored summary and
      // extracted text describe a file that is no longer being served.
      expect(row.status).toBe(DocumentStatus.PROCESSING);
      // Each version keeps its own immutable object.
      expect(new Set(versions.map((version) => version.storageKey)).size).toBe(2);
      expect(versions.at(-1)?.note).toBe('second draft');
    });

    /**
     * The document id doubles as the BullMQ job id. Without this the add() is
     * silently ignored while a completed job is still retained, the row sits at
     * PROCESSING forever, and the new bytes are never extracted.
     */
    it('clears the finished job before re-enqueueing', async () => {
      const { service, processing, documents, dir } = await setup();
      const uploaded = await uploadSettled(service, documents, dir);

      processing.forget.mockClear();
      processing.enqueue.mockClear();

      await service.addVersion(uploaded.id, await fakeUpload(dir), {}, USER, COMPANY, CONTEXT);

      expect(processing.forget).toHaveBeenCalledWith(uploaded.id);
      expect(processing.forget.mock.invocationCallOrder[0]).toBeLessThan(
        processing.enqueue.mock.invocationCallOrder[0],
      );
    });

    it('takes the orphaned object with it when the write fails', async () => {
      const { service, storage, db, documents, dir } = await setup();
      const uploaded = await uploadSettled(service, documents, dir);

      jest.spyOn(db.document, 'update').mockImplementationOnce(() => {
        throw new Error('constraint violation');
      });

      await expect(
        service.addVersion(uploaded.id, await fakeUpload(dir), {}, USER, COMPANY, CONTEXT),
      ).rejects.toThrow(/constraint violation/);

      // The document still points at version 1's bytes, so the ones just
      // uploaded are referenced by nothing.
      expect(storage.removeQuietly).toHaveBeenCalledTimes(1);
    });
  });

  describe('revertToVersion', () => {
    it('appends a new version instead of rewinding to the old one', async () => {
      const { service, storage, documents, versions, dir } = await setup();
      const uploaded = await uploadSettled(service, documents, dir, { name: 'original.pdf' });
      const firstKey = documents[0].storageKey;

      await service.addVersion(
        uploaded.id,
        await fakeUpload(dir, { name: 'replacement.txt', type: 'text/plain' }),
        {},
        USER,
        COMPANY,
        CONTEXT,
      );
      settle(documents, uploaded.id);

      const target = versions[0];
      await service.revertToVersion(uploaded.id, target.id, {}, USER, COMPANY, CONTEXT);

      // Three rows, not two: history is append-only.
      expect(versions.map((version) => version.versionNumber)).toEqual([1, 2, 3]);

      // The bytes were copied to a fresh key rather than re-pointed at, because
      // document_versions.storage_key is unique.
      expect(storage.copyObject).toHaveBeenCalledTimes(1);
      const [source, destination] = storage.copyObject.mock.calls[0] as [string, string];
      expect(source).toBe(firstKey);
      expect(destination).not.toBe(firstKey);
      expect(documents[0].storageKey).toBe(destination);
    });

    it('restores the type and filename, not just the bytes', async () => {
      const { service, documents, versions, dir } = await setup();
      const uploaded = await uploadSettled(service, documents, dir, {
        name: 'original.pdf',
        type: 'application/pdf',
      });

      await service.addVersion(
        uploaded.id,
        await fakeUpload(dir, { name: 'notes.txt', type: 'text/plain' }),
        {},
        USER,
        COMPANY,
        CONTEXT,
      );
      settle(documents, uploaded.id);

      expect(documents[0].mimeType).toBe('text/plain');

      await service.revertToVersion(uploaded.id, versions[0].id, {}, USER, COMPANY, CONTEXT);

      expect(documents[0].mimeType).toBe('application/pdf');
      expect(documents[0].originalName).toBe('original.pdf');
      expect(documents[0].extension).toBe('pdf');
    });

    it('404s a version id belonging to another document', async () => {
      const { service, documents, versions, dir } = await setup();
      const a = await uploadSettled(service, documents, dir);
      await uploadSettled(service, documents, dir);

      // Version 1 of the SECOND document, asked for against the first.
      const foreign = versions[1];

      await expect(
        service.revertToVersion(a.id, foreign.id, {}, USER, COMPANY, CONTEXT),
      ).rejects.toThrow(/version does not exist/);
    });
  });

  describe('archive', () => {
    it('moves to ARCHIVED and back to READY', async () => {
      const { service, documents, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      settle(documents, uploaded.id);

      const archived = await service.archive(uploaded.id, CONTEXT);
      expect(archived.status).toBe(DocumentStatus.ARCHIVED);

      const restored = await service.unarchive(uploaded.id, CONTEXT);
      expect(restored.status).toBe(DocumentStatus.READY);
    });

    it('refuses to archive twice, or to unarchive what is not archived', async () => {
      const { service, documents, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      settle(documents, uploaded.id);

      await expect(service.unarchive(uploaded.id, CONTEXT)).rejects.toThrow(/not archived/);

      await service.archive(uploaded.id, CONTEXT);

      await expect(service.archive(uploaded.id, CONTEXT)).rejects.toThrow(/already archived/);
    });

    /**
     * The pipeline ends with an unconditional advance to READY, so a document
     * archived while a worker held it would quietly un-archive itself when that
     * worker finished — with nothing in the audit trail to explain it.
     */
    it('refuses while a worker still has the document', async () => {
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);

      // upload leaves it at PROCESSING.
      await expect(service.archive(uploaded.id, CONTEXT)).rejects.toThrow(
        /already being processed/,
      );
    });

    it('is read-only: every write is refused while archived', async () => {
      const { service, documents, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      settle(documents, uploaded.id);
      await service.archive(uploaded.id, CONTEXT);

      await expect(service.update(uploaded.id, { name: 'new name' }, CONTEXT)).rejects.toThrow(
        /archived/,
      );
      await expect(service.reprocess(uploaded.id, USER, COMPANY, CONTEXT)).rejects.toThrow(
        /archived/,
      );
      await expect(
        service.addVersion(uploaded.id, await fakeUpload(dir), {}, USER, COMPANY, CONTEXT),
      ).rejects.toThrow(/archived/);
    });

    /**
     * Reading, downloading and binning an archived document all still work.
     * Freezing a record is not sealing it away, and one that could not be
     * deleted would be a document nobody could ever get rid of.
     */
    it('still allows reads and deletion', async () => {
      const { service, documents, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      settle(documents, uploaded.id);
      await service.archive(uploaded.id, CONTEXT);

      await expect(
        service.openForDownload(uploaded.id, CONTEXT, { inline: false }),
      ).resolves.toBeDefined();
      await expect(service.remove(uploaded.id, CONTEXT)).resolves.toBeDefined();
    });

    it('is hidden from the default list but reachable two ways', async () => {
      const { service, documents, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      settle(documents, uploaded.id);
      await service.archive(uploaded.id, CONTEXT);

      await expect(service.list({}, USER)).resolves.toMatchObject({ items: [] });

      await expect(service.list({ includeArchived: 'true' }, USER)).resolves.toMatchObject({
        items: [{ id: uploaded.id }],
      });

      await expect(
        service.list({ status: DocumentStatusFilter.ARCHIVED }, USER),
      ).resolves.toMatchObject({
        items: [{ id: uploaded.id }],
      });
    });
  });
});
