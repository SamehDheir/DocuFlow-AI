import { randomUUID } from 'node:crypto';
import type { AuditService } from '../common/audit/audit.service';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { FoldersService, MAX_FOLDER_DEPTH } from './folders.service';

interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DocumentRow {
  id: string;
  folderId: string | null;
  deletedAt: Date | null;
}

/**
 * In-memory stand-in for the tenant-guarded client, in the style of
 * token.service.spec.ts. Tenant filtering is not simulated — the guard has its
 * own spec, and mixing the two here would test the mock rather than the rules
 * this service is responsible for.
 */
function createDb() {
  const folders: FolderRow[] = [];
  const documents: DocumentRow[] = [];

  const matches = (row: object, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([field, expected]) => {
      const actual = (row as Record<string, unknown>)[field];

      if (expected && typeof expected === 'object' && 'not' in expected) {
        return actual !== expected.not;
      }

      return actual === expected;
    });

  /**
   * Every read hands back a COPY, as Prisma does.
   *
   * Returning the live row instead would let a later `update` mutate a snapshot
   * the service is still holding — so a rename would compare the new name
   * against itself, and the change would look like a no-op.
   */
  const copy = <T>(row: T): T => ({ ...row });

  const db = {
    folder: {
      create: ({ data }: { data: Omit<FolderRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
        const row: FolderRow = {
          ...data,
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        folders.push(row);
        return Promise.resolve(copy(row));
      },
      findFirst: ({ where }: { where?: Record<string, unknown> }) => {
        const row = folders.find((candidate) => matches(candidate, where));
        return Promise.resolve(row ? copy(row) : null);
      },
      findMany: ({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(folders.filter((row) => matches(row, where)).map(copy)),
      update: ({ where, data }: { where: { id: string }; data: Partial<FolderRow> }) => {
        const row = folders.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return Promise.resolve(copy(row));
      },
      delete: ({ where }: { where: { id: string } }) => {
        const index = folders.findIndex((row) => row.id === where.id);
        const [removed] = folders.splice(index, 1);
        return Promise.resolve(copy(removed));
      },
      count: ({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(folders.filter((row) => matches(row, where)).length),
    },
    document: {
      count: ({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(documents.filter((row) => matches(row, where)).length),
    },
  };

  return { db, folders, documents };
}

function setup() {
  const { db, folders, documents } = createDb();
  // Kept as the concrete mock shape, not the service type, so assertions read
  // a jest.Mock rather than an unbound class method.
  const audit: { record: jest.Mock } = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new FoldersService(
    db as unknown as TenantGuardedClient,
    audit as unknown as AuditService,
  );

  return { service, audit, folders, documents };
}

const USER = 'user-1';
const CONTEXT = { ipAddress: '127.0.0.1', userAgent: 'jest' };

describe('FoldersService', () => {
  describe('create', () => {
    it('records an audit row', async () => {
      const { service, audit } = setup();

      const folder = await service.create({ name: 'Contracts' }, USER, CONTEXT);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'folder.create', entityId: folder.id }),
      );
    });

    it('refuses a duplicate name at the ROOT', async () => {
      // The composite unique cannot catch this: Postgres treats NULL parent_id
      // values as distinct, so two root folders named the same satisfy it.
      const { service } = setup();
      await service.create({ name: 'Contracts' }, USER, CONTEXT);

      await expect(service.create({ name: 'Contracts' }, USER, CONTEXT)).rejects.toThrow(
        /already here/,
      );
    });

    it('refuses a duplicate name among siblings', async () => {
      const { service } = setup();
      const parent = await service.create({ name: 'Legal' }, USER, CONTEXT);
      await service.create({ name: 'Contracts', parentId: parent.id }, USER, CONTEXT);

      await expect(
        service.create({ name: 'Contracts', parentId: parent.id }, USER, CONTEXT),
      ).rejects.toThrow(/already here/);
    });

    it('allows the same name under different parents', async () => {
      const { service } = setup();
      const legal = await service.create({ name: 'Legal' }, USER, CONTEXT);
      const finance = await service.create({ name: 'Finance' }, USER, CONTEXT);

      await service.create({ name: '2026', parentId: legal.id }, USER, CONTEXT);

      await expect(
        service.create({ name: '2026', parentId: finance.id }, USER, CONTEXT),
      ).resolves.toMatchObject({ name: '2026' });
    });

    it('404s on an unknown parent', async () => {
      const { service } = setup();

      await expect(
        service.create({ name: 'Orphan', parentId: randomUUID() }, USER, CONTEXT),
      ).rejects.toThrow(/does not exist/);
    });

    it('refuses to nest past the depth cap', async () => {
      const { service } = setup();
      let parentId: string | undefined;

      for (let level = 0; level < MAX_FOLDER_DEPTH - 1; level += 1) {
        const folder = await service.create({ name: `level-${level}`, parentId }, USER, CONTEXT);
        parentId = folder.id;
      }

      await expect(service.create({ name: 'too-deep', parentId }, USER, CONTEXT)).rejects.toThrow(
        /levels deep/,
      );
    });
  });

  describe('update', () => {
    it('renames and audits the rename', async () => {
      const { service, audit } = setup();
      const folder = await service.create({ name: 'Contracts' }, USER, CONTEXT);

      const updated = await service.update(folder.id, { name: 'Agreements' }, CONTEXT);

      expect(updated.name).toBe('Agreements');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'folder.rename',
          metadata: { from: 'Contracts', to: 'Agreements' },
        }),
      );
    });

    it('refuses to move a folder into itself', async () => {
      const { service } = setup();
      const folder = await service.create({ name: 'Contracts' }, USER, CONTEXT);

      await expect(service.update(folder.id, { parentId: folder.id }, CONTEXT)).rejects.toThrow(
        /inside itself/,
      );
    });

    it('refuses to move a folder into its own descendant', async () => {
      // Allowing this detaches the whole branch from the root: unreachable from
      // the tree, and undeletable because nothing in it is ever empty.
      const { service } = setup();
      const root = await service.create({ name: 'Legal' }, USER, CONTEXT);
      const child = await service.create({ name: '2026', parentId: root.id }, USER, CONTEXT);
      const grandchild = await service.create({ name: 'Q1', parentId: child.id }, USER, CONTEXT);

      await expect(service.update(root.id, { parentId: grandchild.id }, CONTEXT)).rejects.toThrow(
        /own subfolders/,
      );
    });

    it('moves to the root when parentId is explicitly null', async () => {
      const { service, audit } = setup();
      const parent = await service.create({ name: 'Legal' }, USER, CONTEXT);
      const child = await service.create({ name: '2026', parentId: parent.id }, USER, CONTEXT);

      const moved = await service.update(child.id, { parentId: null }, CONTEXT);

      expect(moved.parentId).toBeNull();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'folder.move' }));
    });

    it('leaves the parent alone when parentId is absent', async () => {
      const { service } = setup();
      const parent = await service.create({ name: 'Legal' }, USER, CONTEXT);
      const child = await service.create({ name: '2026', parentId: parent.id }, USER, CONTEXT);

      const renamed = await service.update(child.id, { name: '2027' }, CONTEXT);

      expect(renamed.parentId).toBe(parent.id);
    });

    it('refuses a rename that collides with a sibling', async () => {
      const { service } = setup();
      await service.create({ name: 'Contracts' }, USER, CONTEXT);
      const other = await service.create({ name: 'Invoices' }, USER, CONTEXT);

      await expect(service.update(other.id, { name: 'Contracts' }, CONTEXT)).rejects.toThrow(
        /already here/,
      );
    });

    it('allows renaming a folder to the name it already has', async () => {
      const { service } = setup();
      const folder = await service.create({ name: 'Contracts' }, USER, CONTEXT);

      await expect(
        service.update(folder.id, { name: 'Contracts' }, CONTEXT),
      ).resolves.toMatchObject({ name: 'Contracts' });
    });
  });

  describe('remove', () => {
    it('deletes an empty folder', async () => {
      const { service, folders, audit } = setup();
      const folder = await service.create({ name: 'Contracts' }, USER, CONTEXT);

      await service.remove(folder.id, CONTEXT);

      expect(folders).toHaveLength(0);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'folder.delete' }),
      );
    });

    it('refuses a folder that still has subfolders', async () => {
      const { service } = setup();
      const parent = await service.create({ name: 'Legal' }, USER, CONTEXT);
      await service.create({ name: '2026', parentId: parent.id }, USER, CONTEXT);

      await expect(service.remove(parent.id, CONTEXT)).rejects.toThrow(/still has items/);
    });

    it('refuses a folder that still has documents', async () => {
      const { service, documents } = setup();
      const folder = await service.create({ name: 'Contracts' }, USER, CONTEXT);
      documents.push({ id: 'doc-1', folderId: folder.id, deletedAt: null });

      await expect(service.remove(folder.id, CONTEXT)).rejects.toThrow(/still has items/);
    });

    it('refuses a folder whose only documents are in the trash', async () => {
      // A trashed document is restorable, and restoring it into a folder that
      // no longer exists would strand it at the root.
      const { service, documents } = setup();
      const folder = await service.create({ name: 'Contracts' }, USER, CONTEXT);
      documents.push({ id: 'doc-1', folderId: folder.id, deletedAt: new Date() });

      await expect(service.remove(folder.id, CONTEXT)).rejects.toThrow(/still has items/);
    });
  });

  describe('findOne', () => {
    it('returns a root-first breadcrumb', async () => {
      const { service } = setup();
      const root = await service.create({ name: 'Legal' }, USER, CONTEXT);
      const child = await service.create({ name: '2026', parentId: root.id }, USER, CONTEXT);
      const leaf = await service.create({ name: 'Q1', parentId: child.id }, USER, CONTEXT);

      const { breadcrumb } = await service.findOne(leaf.id);

      expect(breadcrumb.map((entry) => entry.name)).toEqual(['Legal', '2026', 'Q1']);
    });

    it('404s on an unknown folder', async () => {
      const { service } = setup();

      await expect(service.findOne(randomUUID())).rejects.toThrow(/does not exist/);
    });
  });
});
