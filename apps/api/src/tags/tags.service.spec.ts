import { randomUUID } from 'node:crypto';
import { DocumentStatus } from '@prisma/client';
import type { AuditService } from '../common/audit/audit.service';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { TagColor } from './dto/tag.dto';
import { TagsService } from './tags.service';

const CONTEXT = { ipAddress: '127.0.0.1', userAgent: 'jest' };

interface TagRow {
  id: string;
  name: string;
  color: string | null;
  createdAt: Date;
}

interface DocRow {
  id: string;
  name: string;
  status: DocumentStatus;
  deletedAt: Date | null;
}

/**
 * In-memory client.
 *
 * Note what it deliberately does NOT offer: a way to reach `documentTag` by
 * document id. The real join model carries no companyId, so the tenant guard
 * leaves a direct query on it unfiltered — a fake with that convenience would
 * let a spec pass against code that reads across tenants.
 */
function createDb() {
  const tags: TagRow[] = [];
  const documents: DocRow[] = [];
  const links: { documentId: string; tagId: string }[] = [];

  const copy = <T>(row: T): T => ({ ...row });

  const db = {
    tag: {
      findMany: ({ where }: { where?: { id?: { in: string[] } } } = {}) => {
        const wanted = where?.id?.in;
        const rows = wanted ? tags.filter((tag) => wanted.includes(tag.id)) : [...tags];

        return Promise.resolve(
          rows
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((tag) => ({
              ...copy(tag),
              _count: {
                documents: links.filter((link) => {
                  if (link.tagId !== tag.id) return false;
                  const document = documents.find((row) => row.id === link.documentId);
                  return (
                    document?.deletedAt === null && document.status !== DocumentStatus.ARCHIVED
                  );
                }).length,
              },
            })),
        );
      },
      findFirst: ({ where }: { where: { id?: string; name?: string; NOT?: unknown } }) => {
        const row = tags.find((tag) => {
          if (where.id && tag.id !== where.id) return false;
          if (where.name && tag.name !== where.name) return false;
          const exclude = (where as { id?: { not?: string } }).id;
          if (exclude && typeof exclude === 'object' && exclude.not === tag.id) return false;
          return true;
        });

        return Promise.resolve(row ? copy(row) : null);
      },
      create: ({ data }: { data: { name: string; color: string | null } }) => {
        const row = { ...data, id: randomUUID(), createdAt: new Date() };
        tags.push(row);
        return Promise.resolve(copy(row));
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<TagRow> }) => {
        const row = tags.find((tag) => tag.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return Promise.resolve(copy(row));
      },
      delete: ({ where }: { where: { id: string } }) => {
        const index = tags.findIndex((tag) => tag.id === where.id);
        const [removed] = tags.splice(index, 1);
        // Cascade, as the foreign key would.
        for (let i = links.length - 1; i >= 0; i -= 1) {
          if (links[i].tagId === where.id) links.splice(i, 1);
        }
        return Promise.resolve(removed);
      },
    },
    documentTag: {
      count: ({ where }: { where: { tagId: string } }) =>
        Promise.resolve(links.filter((link) => link.tagId === where.tagId).length),
    },
    document: {
      findFirst: ({ where }: { where: { id: string; deletedAt: null } }) => {
        const row = documents.find(
          (document) => document.id === where.id && document.deletedAt === null,
        );

        if (!row) return Promise.resolve(null);

        return Promise.resolve({
          ...copy(row),
          tags: links
            .filter((link) => link.documentId === row.id)
            .map((link) => ({ tag: copy(tags.find((tag) => tag.id === link.tagId) as TagRow) })),
        });
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: { tags?: { deleteMany?: object; create?: { tagId: string }[] } };
      }) => {
        if (data.tags?.deleteMany) {
          for (let i = links.length - 1; i >= 0; i -= 1) {
            if (links[i].documentId === where.id) links.splice(i, 1);
          }
        }

        for (const created of data.tags?.create ?? []) {
          links.push({ documentId: where.id, tagId: created.tagId });
        }

        return Promise.resolve({ id: where.id });
      },
    },
  };

  return { db, tags, documents, links };
}

function setup() {
  const { db, tags, documents, links } = createDb();
  const audit: { record: jest.Mock } = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new TagsService(
    db as unknown as TenantGuardedClient,
    audit as unknown as AuditService,
  );

  const addDocument = (status: DocumentStatus = DocumentStatus.READY) => {
    const row = { id: randomUUID(), name: 'contract.pdf', status, deletedAt: null };
    documents.push(row);
    return row;
  };

  return { service, audit, tags, documents, links, addDocument };
}

describe('TagsService', () => {
  describe('create', () => {
    it('refuses a duplicate name with a field-level message', async () => {
      const { service } = setup();
      await service.create({ name: 'Urgent' }, CONTEXT);

      await expect(service.create({ name: 'Urgent' }, CONTEXT)).rejects.toThrow(/already exists/);
    });

    it('stores a token name, never a colour literal', async () => {
      const { service } = setup();
      const tag = await service.create({ name: 'Legal', color: TagColor.ACCENT }, CONTEXT);

      expect(tag.color).toBe('accent');
    });
  });

  describe('remove', () => {
    it('reports how many documents it unlabelled rather than refusing', async () => {
      const { service, addDocument } = setup();
      const tag = await service.create({ name: 'Q3' }, CONTEXT);
      const document = addDocument();

      await service.setForDocument(document.id, { tagIds: [tag.id] }, CONTEXT);

      // Unlike a folder, a tag in use is still deletable: removing a label
      // leaves every document exactly where it was.
      await expect(service.remove(tag.id, CONTEXT)).resolves.toEqual({
        id: tag.id,
        unlabelled: 1,
      });
    });
  });

  describe('setForDocument', () => {
    it('replaces the whole set rather than merging into it', async () => {
      const { service, addDocument } = setup();
      const a = await service.create({ name: 'A' }, CONTEXT);
      const b = await service.create({ name: 'B' }, CONTEXT);
      const c = await service.create({ name: 'C' }, CONTEXT);
      const document = addDocument();

      await service.setForDocument(document.id, { tagIds: [a.id, b.id] }, CONTEXT);
      const result = await service.setForDocument(document.id, { tagIds: [c.id] }, CONTEXT);

      // B is gone, not merged with C.
      expect(result.map((tag) => tag.name)).toEqual(['C']);
    });

    it('accepts the empty set, because untagging is a real intention', async () => {
      const { service, addDocument, links } = setup();
      const tag = await service.create({ name: 'A' }, CONTEXT);
      const document = addDocument();

      await service.setForDocument(document.id, { tagIds: [tag.id] }, CONTEXT);
      await expect(service.setForDocument(document.id, { tagIds: [] }, CONTEXT)).resolves.toEqual(
        [],
      );

      expect(links).toHaveLength(0);
    });

    it('is idempotent, and records nothing when the set has not moved', async () => {
      const { service, audit, addDocument } = setup();
      const tag = await service.create({ name: 'A' }, CONTEXT);
      const document = addDocument();

      await service.setForDocument(document.id, { tagIds: [tag.id] }, CONTEXT);
      audit.record.mockClear();

      const again = await service.setForDocument(document.id, { tagIds: [tag.id] }, CONTEXT);

      expect(again.map((entry) => entry.id)).toEqual([tag.id]);
      expect(audit.record).not.toHaveBeenCalled();
    });

    /**
     * The tenant-scoped read is what makes this a 404 rather than a 500. An id
     * from another company does not come back from `tag.findMany`, so the whole
     * call is refused before the nested create could raise a raw foreign-key
     * violation.
     */
    it('404s an unknown tag instead of surfacing a constraint error', async () => {
      const { service, addDocument } = setup();
      const document = addDocument();

      await expect(
        service.setForDocument(document.id, { tagIds: [randomUUID()] }, CONTEXT),
      ).rejects.toThrow(/tag does not exist/);
    });

    it('refuses to tag an archived document', async () => {
      const { service, addDocument } = setup();
      const tag = await service.create({ name: 'A' }, CONTEXT);
      const document = addDocument(DocumentStatus.ARCHIVED);

      await expect(
        service.setForDocument(document.id, { tagIds: [tag.id] }, CONTEXT),
      ).rejects.toThrow(/archived/);
    });

    it('404s a document that does not exist', async () => {
      const { service } = setup();

      await expect(service.setForDocument(randomUUID(), { tagIds: [] }, CONTEXT)).rejects.toThrow(
        /document does not exist/,
      );
    });
  });

  describe('list', () => {
    it('counts only what the tag filter would actually show', async () => {
      const { service, addDocument } = setup();
      const tag = await service.create({ name: 'Shared' }, CONTEXT);

      const live = addDocument();
      const archived = addDocument(DocumentStatus.ARCHIVED);

      await service.setForDocument(live.id, { tagIds: [tag.id] }, CONTEXT);
      // Tagged before archiving, which is the only way to get here.
      archived.status = DocumentStatus.READY;
      await service.setForDocument(archived.id, { tagIds: [tag.id] }, CONTEXT);
      archived.status = DocumentStatus.ARCHIVED;

      const [listed] = await service.list();

      expect(listed.documentCount).toBe(1);
    });
  });
});
