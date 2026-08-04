import { randomUUID } from 'node:crypto';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { AuditQueryService } from './audit-query.service';
import { DEFAULT_PAGE_SIZE } from '../documents/dto/list-documents.dto';

/**
 * This service builds a query and slices the result; it owns no other logic.
 * So the fake records the arguments rather than re-implementing Prisma's
 * ordering and cursor semantics — a hand-rolled `orderBy`/`skip` would end up
 * testing the fake instead of the service.
 */
function createDb(rows: { id: string }[] = []) {
  const calls: Record<string, unknown>[] = [];

  const db = {
    auditLog: {
      findMany: (args: Record<string, unknown>) => {
        calls.push(args);

        if (args.distinct) {
          return Promise.resolve(rows);
        }

        return Promise.resolve(rows.slice(0, (args.take as number) ?? rows.length));
      },
    },
  };

  return { db: db as unknown as TenantGuardedClient, calls };
}

const entries = (count: number) => Array.from({ length: count }, () => ({ id: randomUUID() }));

describe('AuditQueryService', () => {
  describe('list', () => {
    it('orders newest first and breaks ties on id', async () => {
      const { db, calls } = createDb();
      await new AuditQueryService(db).list({});

      expect(calls[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('never filters by companyId — the tenant guard injects it', async () => {
      const { db, calls } = createDb();
      await new AuditQueryService(db).list({});

      expect(calls[0].where).not.toHaveProperty('companyId');
    });

    it('defaults to the shared page size and fetches one extra row', async () => {
      const { db, calls } = createDb();
      await new AuditQueryService(db).list({});

      expect(calls[0].take).toBe(DEFAULT_PAGE_SIZE + 1);
    });

    it('reports a nextCursor only when another page exists', async () => {
      const { db } = createDb(entries(4));
      const page = await new AuditQueryService(db).list({ limit: 3 });

      expect(page.items).toHaveLength(3);
      expect(page.nextCursor).toBe(page.items[2].id);
    });

    it('returns a null cursor on the last page', async () => {
      const { db } = createDb(entries(2));
      const page = await new AuditQueryService(db).list({ limit: 3 });

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });

    it('skips the cursor row itself so a page never repeats an entry', async () => {
      const cursor = randomUUID();
      const { db, calls } = createDb();
      await new AuditQueryService(db).list({ cursor });

      expect(calls[0].cursor).toEqual({ id: cursor });
      expect(calls[0].skip).toBe(1);
    });

    it('omits cursor and skip entirely on the first page', async () => {
      const { db, calls } = createDb();
      await new AuditQueryService(db).list({});

      expect(calls[0]).not.toHaveProperty('cursor');
      expect(calls[0]).not.toHaveProperty('skip');
    });

    it('composes every filter into one where clause', async () => {
      const userId = randomUUID();
      const { db, calls } = createDb();

      await new AuditQueryService(db).list({
        action: 'document.upload',
        entityType: 'Document',
        entityId: 'abc',
        userId,
      });

      expect(calls[0].where).toEqual({
        action: 'document.upload',
        entityType: 'Document',
        entityId: 'abc',
        userId,
      });
    });

    it('turns from/to into a single createdAt range', async () => {
      const { db, calls } = createDb();

      await new AuditQueryService(db).list({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-01T00:00:00.000Z',
      });

      expect(calls[0].where).toEqual({
        createdAt: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lte: new Date('2026-02-01T00:00:00.000Z'),
        },
      });
    });

    it('accepts an open-ended range', async () => {
      const { db, calls } = createDb();
      await new AuditQueryService(db).list({ from: '2026-01-01T00:00:00.000Z' });

      expect(calls[0].where).toEqual({
        createdAt: { gte: new Date('2026-01-01T00:00:00.000Z') },
      });
    });

    it('sends no where clause at all when nothing is filtered', async () => {
      const { db, calls } = createDb();
      await new AuditQueryService(db).list({});

      expect(calls[0].where).toEqual({});
    });
  });

  describe('actions', () => {
    it('returns the distinct actions this company has recorded', async () => {
      const rows = [{ action: 'document.upload' }, { action: 'folder.create' }];
      const { db, calls } = createDb(rows as unknown as { id: string }[]);

      const result = await new AuditQueryService(db).actions();

      expect(calls[0].distinct).toEqual(['action']);
      expect(result).toEqual(['document.upload', 'folder.create']);
    });
  });
});
