import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { DocumentStatus } from '@prisma/client';
import type { AuditService } from '../common/audit/audit.service';
import type { Env } from '../config/env.validation';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import type { DocumentProcessingProducer } from '../queue/document-processing.producer';
import type { StorageService } from '../storage/storage.service';
import { DocumentsService, type UploadedFile } from './documents.service';

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

/**
 * In-memory client, in the style of token.service.spec.ts. Reads return copies
 * so an update cannot mutate a snapshot the service is still holding.
 */
function createDb() {
  const documents: DocRow[] = [];
  const folders: { id: string }[] = [];
  const versions: { documentId: string; versionNumber: number }[] = [];

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
    findFirst: ({ where }: { where?: Record<string, unknown> }) => {
      const row = documents.find((candidate) => matches(candidate, where));
      return Promise.resolve(row ? copy(row) : null);
    },
    findMany: ({ where, take }: { where?: Record<string, unknown>; take?: number }) =>
      Promise.resolve(
        documents
          .filter((row) => matches(row, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take)
          .map(copy),
      ),
    update: ({ where, data }: { where: { id: string }; data: Partial<DocRow> }) => {
      const row = documents.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: new Date() });
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
    documentVersion: {
      create: ({ data }: { data: { documentId: string; versionNumber: number } }) => {
        versions.push(data);
        return Promise.resolve(data);
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

  const service = new DocumentsService(
    db as unknown as TenantGuardedClient,
    storage as unknown as StorageService,
    audit as unknown as AuditService,
    processing as unknown as DocumentProcessingProducer,
    config,
  );

  const dir = await mkdtemp(join(tmpdir(), 'docuflow-spec-'));

  return { service, audit, storage, processing, documents, folders, versions, dir };
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

      const { items } = await service.list({});

      expect(items).toEqual([]);
    });

    it('shows it in the trash listing instead', async () => {
      const { service, dir } = await setup();
      const uploaded = await service.upload(await fakeUpload(dir), {}, USER, CONTEXT, COMPANY);
      await service.remove(uploaded.id, CONTEXT);

      const { items } = await service.list({ trash: 'true' });

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
});
