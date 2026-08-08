import { randomUUID } from 'node:crypto';
import { DocumentStatus } from '@prisma/client';
import type { AuditService } from '../common/audit/audit.service';
import { ERROR_CODES } from '../common/errors/error-codes';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { BulkDocumentsService } from './bulk-documents.service';

const CONTEXT = { ipAddress: '127.0.0.1', userAgent: 'jest' };

interface DocRow {
  id: string;
  name: string;
  status: DocumentStatus;
  folderId: string | null;
  deletedAt: Date | null;
}

/**
 * In-memory client.
 *
 * `document.findMany` is the only way in, which mirrors the real constraint:
 * every id the service acts on has to come back from a tenant-scoped read
 * first. The `documentTag` delegate records its calls rather than modelling
 * links, because what matters about those two statements is that they are
 * confined to ids the read already vouched for.
 */
function createDb() {
  const documents: DocRow[] = [];
  const folders: { id: string }[] = [];
  const tags: { id: string }[] = [];

  const copy = <T>(row: T): T => ({ ...row });

  const tagWrites = {
    deleteMany: [] as { documentId: { in: string[] }; tagId: { in: string[] } }[],
    createMany: [] as { documentId: string; tagId: string }[][],
  };

  const db = {
    document: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(documents.filter((row) => where.id.in.includes(row.id)).map(copy)),
      updateMany: ({ where, data }: { where: { id: { in: string[] } }; data: Partial<DocRow> }) => {
        const rows = documents.filter((row) => where.id.in.includes(row.id));
        for (const row of rows) Object.assign(row, data);
        return Promise.resolve({ count: rows.length });
      },
    },
    folder: {
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(folders.find((folder) => folder.id === where.id) ?? null),
    },
    tag: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(tags.filter((tag) => where.id.in.includes(tag.id)).map(copy)),
    },
    documentTag: {
      deleteMany: ({
        where,
      }: {
        where: { documentId: { in: string[] }; tagId: { in: string[] } };
      }) => {
        tagWrites.deleteMany.push(where);
        return Promise.resolve({ count: 0 });
      },
      createMany: ({ data }: { data: { documentId: string; tagId: string }[] }) => {
        tagWrites.createMany.push(data);
        return Promise.resolve({ count: data.length });
      },
    },
  };

  return { db, documents, folders, tags, tagWrites };
}

function setup() {
  const { db, documents, folders, tags, tagWrites } = createDb();
  const audit = { record: jest.fn(), recordMany: jest.fn().mockResolvedValue(undefined) };

  const service = new BulkDocumentsService(
    db as unknown as TenantGuardedClient,
    audit as unknown as AuditService,
  );

  const addDocument = (overrides: Partial<DocRow> = {}): DocRow => {
    const row: DocRow = {
      id: randomUUID(),
      name: 'contract.pdf',
      status: DocumentStatus.READY,
      folderId: null,
      deletedAt: null,
      ...overrides,
    };
    documents.push(row);
    return row;
  };

  const addFolder = () => {
    const folder = { id: randomUUID() };
    folders.push(folder);
    return folder;
  };

  const addTag = () => {
    const tag = { id: randomUUID() };
    tags.push(tag);
    return tag;
  };

  return { service, audit, documents, tagWrites, addDocument, addFolder, addTag };
}

const codesFor = (skipped: { id: string; code: string }[], id: string) =>
  skipped.filter((entry) => entry.id === id).map((entry) => entry.code);

describe('BulkDocumentsService', () => {
  /**
   * The contract the whole file is built around: one stale row must not cost the
   * user the other forty-nine.
   */
  describe('partial success', () => {
    it('acts on what it can and reports a reason for each refusal', async () => {
      const { service, addDocument } = setup();
      const ready = addDocument();
      const archived = addDocument({ status: DocumentStatus.ARCHIVED });
      const missing = randomUUID();

      const result = await service.archive({ ids: [ready.id, archived.id, missing] }, CONTEXT);

      expect(result.requested).toBe(3);
      expect(result.succeeded).toEqual([ready.id]);
      expect(codesFor(result.skipped, archived.id)).toEqual([
        ERROR_CODES.DOCUMENT_ALREADY_ARCHIVED,
      ]);
      expect(codesFor(result.skipped, missing)).toEqual([ERROR_CODES.DOCUMENT_NOT_FOUND]);
    });

    /**
     * An id from another company does not come back from the tenant-scoped read,
     * so it is indistinguishable from one that never existed. That is the answer
     * that leaks least — "not yours" would confirm the document exists.
     */
    it('counts a duplicated id once', async () => {
      const { service, addDocument } = setup();
      const document = addDocument();

      const result = await service.archive({ ids: [document.id, document.id] }, CONTEXT);

      expect(result.requested).toBe(1);
      expect(result.succeeded).toEqual([document.id]);
    });

    it('writes one audit row per document, flagged as bulk', async () => {
      const { service, audit, addDocument } = setup();
      const first = addDocument();
      const second = addDocument();

      await service.remove({ ids: [first.id, second.id] }, CONTEXT);

      const [entries] = audit.recordMany.mock.calls[0] as [
        { action: string; entityId: string; metadata: { bulk: boolean } }[],
      ];

      // Per document, because "who deleted this file" is a question about one
      // file. Same action name as the single-document route, so existing
      // filters and the activity feed keep working.
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.entityId).sort()).toEqual([first.id, second.id].sort());
      expect(entries.every((entry) => entry.action === 'document.delete')).toBe(true);
      expect(entries.every((entry) => entry.metadata.bulk)).toBe(true);
    });

    it('writes nothing at all when every id is refused', async () => {
      const { service, audit, addDocument } = setup();
      const archived = addDocument({ status: DocumentStatus.ARCHIVED });

      const result = await service.archive({ ids: [archived.id] }, CONTEXT);

      expect(result.succeeded).toEqual([]);
      expect(audit.recordMany).not.toHaveBeenCalled();
    });
  });

  /**
   * These mirror the single-document methods deliberately. The rules live in
   * document-rules.ts precisely so the two cannot disagree, and this is where
   * that agreement is asserted.
   */
  describe('eligibility matches the single-document rules', () => {
    it('refuses to archive a document a worker is holding', async () => {
      const { service, addDocument } = setup();
      const busy = addDocument({ status: DocumentStatus.OCR });

      const result = await service.archive({ ids: [busy.id] }, CONTEXT);

      // The pipeline ends with an unconditional advance to READY, so archiving
      // mid-run would silently undo itself.
      expect(codesFor(result.skipped, busy.id)).toEqual([ERROR_CODES.DOCUMENT_ALREADY_PROCESSING]);
    });

    it('DELETES an archived document, because archive is not a lock', async () => {
      const { service, addDocument } = setup();
      const archived = addDocument({ status: DocumentStatus.ARCHIVED });

      const result = await service.remove({ ids: [archived.id] }, CONTEXT);

      // Matches assertWritable, which is deliberately not applied to deletion:
      // freezing a record is not sealing it away, and the trash is reversible.
      expect(result.succeeded).toEqual([archived.id]);
    });

    it('REFUSES to move an archived document, because that changes what it is', async () => {
      const { service, addDocument, addFolder } = setup();
      const archived = addDocument({ status: DocumentStatus.ARCHIVED });
      const folder = addFolder();

      const result = await service.move({ ids: [archived.id], folderId: folder.id }, CONTEXT);

      expect(codesFor(result.skipped, archived.id)).toEqual([ERROR_CODES.DOCUMENT_ARCHIVED]);
    });

    it('restores only what is actually in the trash', async () => {
      const { service, addDocument } = setup();
      const trashed = addDocument({ deletedAt: new Date(), status: DocumentStatus.DELETED });
      const live = addDocument();

      const result = await service.restore({ ids: [trashed.id, live.id] }, CONTEXT);

      expect(result.succeeded).toEqual([trashed.id]);
      expect(codesFor(result.skipped, live.id)).toEqual([ERROR_CODES.DOCUMENT_NOT_DELETED]);
    });

    it('treats a trashed document as not found for every other action', async () => {
      const { service, addDocument } = setup();
      const trashed = addDocument({ deletedAt: new Date() });

      for (const result of [
        await service.archive({ ids: [trashed.id] }, CONTEXT),
        await service.unarchive({ ids: [trashed.id] }, CONTEXT),
      ]) {
        expect(codesFor(result.skipped, trashed.id)).toEqual([ERROR_CODES.DOCUMENT_NOT_FOUND]);
      }
    });
  });

  describe('move', () => {
    it('404s an unknown folder before touching anything', async () => {
      const { service, audit, addDocument } = setup();
      const document = addDocument();

      await expect(
        service.move({ ids: [document.id], folderId: randomUUID() }, CONTEXT),
      ).rejects.toThrow(/folder does not exist/);

      expect(audit.recordMany).not.toHaveBeenCalled();
    });

    it('accepts null as the company root', async () => {
      const { service, addDocument, addFolder } = setup();
      const folder = addFolder();
      const document = addDocument({ folderId: folder.id });

      const result = await service.move({ ids: [document.id], folderId: null }, CONTEXT);

      expect(result.succeeded).toEqual([document.id]);
      expect(document.folderId).toBeNull();
    });
  });

  describe('tags', () => {
    it('applies a delta rather than replacing the set', async () => {
      const { service, tagWrites, addDocument, addTag } = setup();
      const document = addDocument();
      const keep = addTag();
      const drop = addTag();

      await service.setTags({ ids: [document.id], add: [keep.id], remove: [drop.id] }, CONTEXT);

      // Only the named tag is removed. A whole-set write would clear labels the
      // caller never saw on rows they never opened.
      expect(tagWrites.deleteMany[0].tagId.in).toEqual([drop.id]);
      expect(tagWrites.createMany[0]).toEqual([{ documentId: document.id, tagId: keep.id }]);
    });

    /**
     * DocumentTag carries no companyId, so the guard leaves these two statements
     * unfiltered. What makes them safe is that both id sets were resolved
     * through tenant-scoped reads first — this asserts the ineligible document
     * never reaches them.
     */
    it('confines both writes to ids the scoped read returned', async () => {
      const { service, tagWrites, addDocument, addTag } = setup();
      const eligible = addDocument();
      const archived = addDocument({ status: DocumentStatus.ARCHIVED });
      const foreign = randomUUID();
      const tag = addTag();

      await service.setTags({ ids: [eligible.id, archived.id, foreign], add: [tag.id] }, CONTEXT);

      // Neither the archived row nor the foreign id appears in the payload.
      expect(tagWrites.createMany[0]).toEqual([{ documentId: eligible.id, tagId: tag.id }]);
    });

    it('404s a tag from outside the company rather than raising a constraint error', async () => {
      const { service, addDocument } = setup();
      const document = addDocument();

      await expect(
        service.setTags({ ids: [document.id], add: [randomUUID()] }, CONTEXT),
      ).rejects.toThrow(/tag does not exist/);
    });

    it('refuses a request that asks for nothing', async () => {
      const { service, addDocument } = setup();
      const document = addDocument();

      await expect(service.setTags({ ids: [document.id] }, CONTEXT)).rejects.toThrow(
        /at least one tag/,
      );
    });

    it('refuses a tag named on both sides instead of picking an order', async () => {
      const { service, addDocument, addTag } = setup();
      const document = addDocument();
      const tag = addTag();

      await expect(
        service.setTags({ ids: [document.id], add: [tag.id], remove: [tag.id] }, CONTEXT),
      ).rejects.toThrow(/cannot be both/);
    });

    it('skips the writes entirely when no document is eligible', async () => {
      const { service, tagWrites, addDocument, addTag } = setup();
      const archived = addDocument({ status: DocumentStatus.ARCHIVED });
      const tag = addTag();

      const result = await service.setTags({ ids: [archived.id], add: [tag.id] }, CONTEXT);

      expect(result.succeeded).toEqual([]);
      expect(tagWrites.createMany).toEqual([]);
      expect(tagWrites.deleteMany).toEqual([]);
    });
  });
});
