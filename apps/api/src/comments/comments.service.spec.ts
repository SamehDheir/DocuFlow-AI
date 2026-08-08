import { randomUUID } from 'node:crypto';
import { NotificationType } from '@prisma/client';
import type { AuditService } from '../common/audit/audit.service';
import type { EventsService } from '../events/events.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { CommentsService } from './comments.service';

const CONTEXT = { ipAddress: '127.0.0.1', userAgent: 'jest' };
const COMPANY = randomUUID();

interface CommentRow {
  id: string;
  documentId: string;
  authorId: string;
  body: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

interface DocRow {
  id: string;
  name: string;
  ownerId: string;
  deletedAt: Date | null;
}

/**
 * In-memory client.
 *
 * `comment.findFirst` honours `deletedAt` because every authorisation path in
 * the service reads through it — a fake that returned tombstones would let a
 * spec pass against code that lets someone re-delete or edit a removed comment.
 */
function createDb() {
  const comments: CommentRow[] = [];
  const documents: DocRow[] = [];

  const copy = <T>(row: T): T => ({ ...row });

  const view = (row: CommentRow) => ({
    id: row.id,
    documentId: row.documentId,
    body: row.body,
    editedAt: row.editedAt,
    createdAt: row.createdAt,
    author: { id: row.authorId, firstName: 'A', lastName: 'Author' },
  });

  const matches = (
    row: CommentRow,
    where: { id?: string; documentId?: string; deletedAt?: null },
  ) => {
    if (where.id && row.id !== where.id) return false;
    if (where.documentId && row.documentId !== where.documentId) return false;
    if (where.deletedAt === null && row.deletedAt !== null) return false;
    return true;
  };

  const db = {
    comment: {
      findMany: ({
        where,
        distinct,
        take,
        cursor,
        skip,
      }: {
        where: { documentId?: string; deletedAt?: null };
        distinct?: string[];
        take?: number;
        cursor?: { id: string };
        skip?: number;
      }) => {
        let rows = comments
          .filter((row) => matches(row, where))
          .sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
          );

        if (distinct?.includes('authorId')) {
          const seen = new Set<string>();
          rows = rows.filter((row) => !seen.has(row.authorId) && seen.add(row.authorId));
          return Promise.resolve(rows.map((row) => ({ authorId: row.authorId })));
        }

        if (cursor) {
          const at = rows.findIndex((row) => row.id === cursor.id);
          rows = at === -1 ? [] : rows.slice(at + (skip ?? 0));
        }

        return Promise.resolve(rows.slice(0, take ?? rows.length).map(view));
      },
      count: ({ where }: { where: { documentId?: string; deletedAt?: null } }) =>
        Promise.resolve(comments.filter((row) => matches(row, where)).length),
      findFirst: ({
        where,
        select,
      }: {
        where: { id: string; deletedAt?: null };
        select: Record<string, unknown>;
      }) => {
        const row = comments.find((entry) => matches(entry, where));

        if (!row) return Promise.resolve(null);

        // The service reads two different shapes off this model; the presence of
        // `author` is what tells them apart.
        if (select.author) return Promise.resolve(view(row));

        return Promise.resolve({
          id: row.id,
          authorId: row.authorId,
          documentId: row.documentId,
          body: row.body,
          document: { name: documents.find((doc) => doc.id === row.documentId)?.name ?? '' },
        });
      },
      create: ({ data }: { data: { documentId: string; authorId: string; body: string } }) => {
        const row: CommentRow = {
          ...data,
          id: randomUUID(),
          editedAt: null,
          deletedAt: null,
          createdAt: new Date(Date.now() + comments.length),
        };
        comments.push(row);
        return Promise.resolve(view(row));
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: { body: string; editedAt: Date };
      }) => {
        const row = comments.find((entry) => entry.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return Promise.resolve(view(row));
      },
      updateMany: ({
        where,
        data,
      }: {
        where: { id: string; deletedAt: null };
        data: { deletedAt: Date };
      }) => {
        const rows = comments.filter((entry) => matches(entry, where));
        for (const row of rows) Object.assign(row, data);
        return Promise.resolve({ count: rows.length });
      },
    },
    document: {
      findFirst: ({ where }: { where: { id: string; deletedAt: null } }) => {
        const row = documents.find(
          (document) => document.id === where.id && document.deletedAt === null,
        );

        return Promise.resolve(row ? copy(row) : null);
      },
    },
  };

  return { db, comments, documents };
}

function setup(options: { moderator?: boolean } = {}) {
  const { db, comments, documents } = createDb();

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    createMany: jest.fn().mockResolvedValue(undefined),
    unreadCount: jest.fn().mockResolvedValue(0),
  };
  const events = { publish: jest.fn().mockResolvedValue(undefined) };
  const permissions = {
    effectiveFor: jest
      .fn()
      .mockResolvedValue(new Set(options.moderator ? ['comments.moderate'] : [])),
  };

  const service = new CommentsService(
    db as unknown as TenantGuardedClient,
    notifications as unknown as NotificationsService,
    events as unknown as EventsService,
    permissions as unknown as PermissionsService,
    audit as unknown as AuditService,
  );

  const addDocument = (ownerId: string = randomUUID()): DocRow => {
    const row: DocRow = { id: randomUUID(), name: 'contract.pdf', ownerId, deletedAt: null };
    documents.push(row);
    return row;
  };

  return { service, audit, notifications, events, permissions, comments, documents, addDocument };
}

describe('CommentsService', () => {
  describe('create', () => {
    it('404s a document that is in the trash', async () => {
      const { service, addDocument } = setup();
      const document = addDocument();
      document.deletedAt = new Date();

      await expect(
        service.create(document.id, { body: 'hi' }, randomUUID(), COMPANY, CONTEXT),
      ).rejects.toThrow(/document does not exist/);
    });

    /**
     * The counterpart to the trash case above, and the one worth pinning: an
     * archived document is frozen, not sealed. `assertWritable` in
     * DocumentsService deliberately excludes commenting, so nothing here should
     * reintroduce that check.
     */
    it('accepts a comment on an archived document', async () => {
      const { service, addDocument } = setup();
      const document = addDocument();

      await expect(
        service.create(document.id, { body: 'still relevant' }, randomUUID(), COMPANY, CONTEXT),
      ).resolves.toMatchObject({ body: 'still relevant' });
    });

    it('addresses the owner and everyone already in the thread, never the actor', async () => {
      const { service, notifications, addDocument } = setup();
      const owner = randomUUID();
      const first = randomUUID();
      const second = randomUUID();
      const document = addDocument(owner);

      await service.create(document.id, { body: 'one' }, first, COMPANY, CONTEXT);
      notifications.createMany.mockClear();

      await service.create(document.id, { body: 'two' }, second, COMPANY, CONTEXT);

      const [recipients, entry, except] = notifications.createMany.mock.calls[0] as [
        string[],
        { type: NotificationType },
        string,
      ];

      // Read before the insert, so the actor is not in the list at all — the
      // exceptUserId below is a second line of defence, not the only one.
      expect(new Set(recipients)).toEqual(new Set([owner, first]));
      expect(entry.type).toBe(NotificationType.DOCUMENT_COMMENTED);
      expect(except).toBe(second);
    });

    it('publishes a company-wide change event carrying ids only', async () => {
      const { service, events, addDocument } = setup();
      const document = addDocument();

      const comment = await service.create(
        document.id,
        { body: 'look at this' },
        randomUUID(),
        COMPANY,
        CONTEXT,
      );

      expect(events.publish).toHaveBeenCalledWith({
        companyId: COMPANY,
        event: { type: 'comment.changed', documentId: document.id, commentId: comment.id },
      });
    });
  });

  describe('update', () => {
    it('refuses an edit by anyone but the author', async () => {
      const { service, addDocument } = setup();
      const author = randomUUID();
      const document = addDocument();
      const comment = await service.create(document.id, { body: 'mine' }, author, COMPANY, CONTEXT);

      await expect(
        service.update(comment.id, { body: 'yours now' }, randomUUID(), COMPANY, CONTEXT),
      ).rejects.toThrow(/only edit your own/);
    });

    /**
     * `comments.moderate` is "delete anyone's comment". Putting different words
     * in someone's mouth is not moderation, so the permission buys nothing here.
     */
    it('refuses an edit even by a moderator', async () => {
      const { service, addDocument } = setup({ moderator: true });
      const document = addDocument();
      const comment = await service.create(
        document.id,
        { body: 'mine' },
        randomUUID(),
        COMPANY,
        CONTEXT,
      );

      await expect(
        service.update(comment.id, { body: 'rewritten' }, randomUUID(), COMPANY, CONTEXT),
      ).rejects.toThrow(/only edit your own/);
    });

    it('marks a real edit', async () => {
      const { service, addDocument } = setup();
      const author = randomUUID();
      const document = addDocument();
      const comment = await service.create(
        document.id,
        { body: 'frist' },
        author,
        COMPANY,
        CONTEXT,
      );

      const updated = await service.update(comment.id, { body: 'first' }, author, COMPANY, CONTEXT);

      expect(updated.body).toBe('first');
      expect(updated.editedAt).toBeInstanceOf(Date);
    });

    it('does not mark a re-send of the same text as an edit', async () => {
      const { service, audit, addDocument } = setup();
      const author = randomUUID();
      const document = addDocument();
      const comment = await service.create(document.id, { body: 'same' }, author, COMPANY, CONTEXT);
      audit.record.mockClear();

      const again = await service.update(comment.id, { body: 'same' }, author, COMPANY, CONTEXT);

      expect(again.editedAt).toBeNull();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s a comment that has been deleted', async () => {
      const { service, addDocument } = setup();
      const author = randomUUID();
      const document = addDocument();
      const comment = await service.create(document.id, { body: 'gone' }, author, COMPANY, CONTEXT);

      await service.remove(comment.id, author, COMPANY, CONTEXT);

      await expect(
        service.update(comment.id, { body: 'back' }, author, COMPANY, CONTEXT),
      ).rejects.toThrow(/comment does not exist/);
    });
  });

  describe('remove', () => {
    it('lets the author delete their own without any moderate permission', async () => {
      const { service, permissions, addDocument, comments } = setup();
      const author = randomUUID();
      const document = addDocument();
      const comment = await service.create(document.id, { body: 'oops' }, author, COMPANY, CONTEXT);

      await expect(service.remove(comment.id, author, COMPANY, CONTEXT)).resolves.toEqual({
        id: comment.id,
      });

      // The permission is not even consulted for one's own comment.
      expect(permissions.effectiveFor).not.toHaveBeenCalled();
      expect(comments[0].deletedAt).toBeInstanceOf(Date);
    });

    it("refuses a colleague's comment without comments.moderate", async () => {
      const { service, addDocument } = setup();
      const document = addDocument();
      const comment = await service.create(
        document.id,
        { body: 'theirs' },
        randomUUID(),
        COMPANY,
        CONTEXT,
      );

      await expect(service.remove(comment.id, randomUUID(), COMPANY, CONTEXT)).rejects.toThrow(
        /only delete your own/,
      );
    });

    it("allows a colleague's comment with comments.moderate, and records that it was moderated", async () => {
      const { service, audit, addDocument } = setup({ moderator: true });
      const document = addDocument();
      const comment = await service.create(
        document.id,
        { body: 'theirs' },
        randomUUID(),
        COMPANY,
        CONTEXT,
      );
      audit.record.mockClear();

      await expect(
        service.remove(comment.id, randomUUID(), COMPANY, CONTEXT),
      ).resolves.toBeDefined();

      const [entry] = audit.record.mock.calls[0] as [
        { action: string; metadata: { moderated: boolean } },
      ];

      expect(entry.action).toBe('comment.delete');
      // Someone deleting their own remark and someone deleting a colleague's
      // are different events wearing the same action name.
      expect(entry.metadata.moderated).toBe(true);
    });

    /** Soft, not hard: "who deleted what" includes what was said. */
    it('keeps the row and its text', async () => {
      const { service, addDocument, comments } = setup();
      const author = randomUUID();
      const document = addDocument();
      const comment = await service.create(
        document.id,
        { body: 'on the record' },
        author,
        COMPANY,
        CONTEXT,
      );

      await service.remove(comment.id, author, COMPANY, CONTEXT);

      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe('on the record');
    });
  });

  describe('forDocument', () => {
    it('reads oldest first, and hides what was deleted from both items and total', async () => {
      const { service, addDocument } = setup();
      const author = randomUUID();
      const document = addDocument();

      await service.create(document.id, { body: 'one' }, author, COMPANY, CONTEXT);
      const second = await service.create(document.id, { body: 'two' }, author, COMPANY, CONTEXT);
      await service.create(document.id, { body: 'three' }, author, COMPANY, CONTEXT);

      await service.remove(second.id, author, COMPANY, CONTEXT);

      const thread = await service.forDocument(document.id, {});

      expect(thread.items.map((item) => item.body)).toEqual(['one', 'three']);
      // The count and the list agree, so a badge cannot promise a comment the
      // thread will not show.
      expect(thread.total).toBe(2);
    });

    it('reports a next cursor only when a further page exists', async () => {
      const { service, addDocument } = setup();
      const author = randomUUID();
      const document = addDocument();

      await service.create(document.id, { body: 'one' }, author, COMPANY, CONTEXT);
      await service.create(document.id, { body: 'two' }, author, COMPANY, CONTEXT);

      const page = await service.forDocument(document.id, { limit: 1 });
      expect(page.nextCursor).not.toBeNull();

      const last = await service.forDocument(document.id, { limit: 1, cursor: page.nextCursor! });
      expect(last.items.map((item) => item.body)).toEqual(['two']);
      expect(last.nextCursor).toBeNull();
    });

    it('404s a document in the trash rather than returning its thread', async () => {
      const { service, addDocument } = setup();
      const document = addDocument();
      await service.create(document.id, { body: 'one' }, randomUUID(), COMPANY, CONTEXT);
      document.deletedAt = new Date();

      await expect(service.forDocument(document.id, {})).rejects.toThrow(/document does not exist/);
    });
  });
});
