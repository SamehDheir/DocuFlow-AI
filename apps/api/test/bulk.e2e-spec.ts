import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { SessionUser } from '../src/auth/auth.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';

/**
 * Bulk operations and favourites, end to end.
 *
 * Needs the local stack running — Postgres AND MinIO:
 *
 *   npm run infra:up
 *
 * Two things here can only be tested against the real router and the real
 * client: that `documents/bulk/restore` is not swallowed by
 * `documents/:id/restore`, and that the relation filters — `?favorite=true` and
 * the nested favourite select — narrow to the person asking rather than to the
 * company. The unit specs use hand-written fakes, which cannot answer either.
 */

interface Session {
  accessToken: string;
  user: SessionUser;
}

interface DocumentBody {
  id: string;
  name: string;
  status: string;
  isFavorite: boolean;
}

interface BulkBody {
  requested: number;
  succeeded: string[];
  skipped: { id: string; code: string }[];
}

type Auth = (req: request.Test) => request.Test;

function accountFor(label: string) {
  const suffix = randomUUID().slice(0, 8);

  return {
    companyName: `Bulk ${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label}.${suffix}@example.test`,
    password: 'correct-horse-battery-staple',
  };
}

describe('Bulk operations and favourites (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let server: App;

  const createdCompanies: string[] = [];

  async function tenant(label: string) {
    const response = await request(server)
      .post('/api/auth/register')
      .send(accountFor(label))
      .expect(201);

    const session = response.body as Session;
    createdCompanies.push(session.user.companyId);

    const auth: Auth = (req) => req.set('Authorization', `Bearer ${session.accessToken}`);

    return { session, auth };
  }

  /** A second Owner in the same company, so two people share every document. */
  async function colleagueOf(owner: Auth) {
    const roles = (await owner(request(server).get('/api/roles')).expect(200)).body as {
      items: { id: string; name: string }[];
    };
    const role = roles.items.find((entry) => entry.name === 'Owner');

    const invited = (
      await owner(request(server).post('/api/invitations'))
        .send({ email: `mate.${randomUUID().slice(0, 8)}@example.test`, roleId: role?.id })
        .expect(201)
    ).body as { link: string };

    const token = new URL(invited.link).searchParams.get('token');

    const session = (
      await request(server)
        .post('/api/auth/accept-invitation')
        .send({
          token,
          firstName: 'Col',
          lastName: 'League',
          password: 'correct-horse-battery-staple',
        })
        .expect(201)
    ).body as Session;

    const auth: Auth = (req) => req.set('Authorization', `Bearer ${session.accessToken}`);

    return { session, auth };
  }

  async function uploadReady(auth: Auth, name = 'doc.txt'): Promise<DocumentBody> {
    const uploaded = (
      await auth(request(server).post('/api/documents'))
        .attach('file', Buffer.from('contents'), { filename: name, contentType: 'text/plain' })
        .expect(201)
    ).body as DocumentBody;

    // The e2e suite runs producer-only, so nothing would otherwise move this
    // past PROCESSING — and PROCESSING is refused by archive.
    await prisma.document.update({ where: { id: uploaded.id }, data: { status: 'READY' } });

    return uploaded;
  }

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const scope = { companyId: { in: createdCompanies } };

    await prisma.document.deleteMany({ where: scope });
    await prisma.folder.deleteMany({ where: scope });
    await prisma.company.deleteMany({ where: { id: { in: createdCompanies } } });

    await app.close();
  });

  /**
   * The regression this whole controller ordering exists to prevent.
   *
   * `documents/bulk/restore` and `documents/:id/restore` are both two-segment
   * patterns. Whichever registers first wins, so DocumentsModule lists
   * BulkDocumentsController ahead of DocumentsController. Undo that and every
   * route below returns a UUID validation error instead of doing anything —
   * which is a 400, so a test that only checked "not 500" would miss it.
   */
  describe('route ordering', () => {
    it('does not let :id/<action> swallow bulk/<action>', async () => {
      const { auth } = await tenant('routing');
      const document = await uploadReady(auth);

      await auth(request(server).post('/api/documents/bulk/delete'))
        .send({ ids: [document.id] })
        .expect(201);

      await auth(request(server).post('/api/documents/bulk/restore'))
        .send({ ids: [document.id] })
        .expect(201);

      // And the single-document routes still work, which is the other half.
      await auth(request(server).delete(`/api/documents/${document.id}`)).expect(200);
      await auth(request(server).post(`/api/documents/${document.id}/restore`)).expect(201);
    });
  });

  describe('partial success', () => {
    it('archives what it can and names what it could not', async () => {
      const { auth } = await tenant('partial');

      const ready = await uploadReady(auth);
      const alreadyArchived = await uploadReady(auth);
      const trashed = await uploadReady(auth);
      const missing = randomUUID();

      await auth(request(server).post(`/api/documents/${alreadyArchived.id}/archive`)).expect(201);
      await auth(request(server).delete(`/api/documents/${trashed.id}`)).expect(200);

      const result = (
        await auth(request(server).post('/api/documents/bulk/archive'))
          .send({ ids: [ready.id, alreadyArchived.id, trashed.id, missing] })
          .expect(201)
      ).body as BulkBody;

      expect(result.requested).toBe(4);
      expect(result.succeeded).toEqual([ready.id]);

      const codes = Object.fromEntries(result.skipped.map((entry) => [entry.id, entry.code]));
      expect(codes[alreadyArchived.id]).toBe('DOCUMENT_ALREADY_ARCHIVED');
      expect(codes[trashed.id]).toBe('DOCUMENT_NOT_FOUND');
      expect(codes[missing]).toBe('DOCUMENT_NOT_FOUND');
    });

    it('leaves one audit row per document, marked as bulk', async () => {
      const { auth } = await tenant('audit');
      const first = await uploadReady(auth);
      const second = await uploadReady(auth);

      await auth(request(server).post('/api/documents/bulk/delete'))
        .send({ ids: [first.id, second.id] })
        .expect(201);

      const trail = (
        await auth(request(server).get('/api/audit?action=document.delete')).expect(200)
      ).body as { items: { entityId: string; metadata: { bulk?: boolean } }[] };

      expect(trail.items).toHaveLength(2);
      expect(trail.items.map((entry) => entry.entityId).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect(trail.items.every((entry) => entry.metadata.bulk === true)).toBe(true);
    });
  });

  describe('move and tags', () => {
    it('re-files a selection and applies a tag delta', async () => {
      const { auth } = await tenant('apply');

      const folder = (
        await auth(request(server).post('/api/folders')).send({ name: 'Contracts' }).expect(201)
      ).body as { id: string };

      const keep = (
        await auth(request(server).post('/api/tags')).send({ name: 'Keep' }).expect(201)
      ).body as { id: string };
      const drop = (
        await auth(request(server).post('/api/tags')).send({ name: 'Drop' }).expect(201)
      ).body as { id: string };

      const first = await uploadReady(auth);
      const second = await uploadReady(auth);
      const ids = [first.id, second.id];

      await auth(request(server).post('/api/documents/bulk/move'))
        .send({ ids, folderId: folder.id })
        .expect(201);

      const filed = (
        await auth(request(server).get(`/api/documents?folderId=${folder.id}`)).expect(200)
      ).body as { items: DocumentBody[] };
      expect(filed.items.map((item) => item.id).sort()).toEqual([...ids].sort());

      // Both get Drop the single-document way, so the delta has something to
      // take away.
      for (const id of ids) {
        await auth(request(server).put(`/api/documents/${id}/tags`))
          .send({ tagIds: [drop.id] })
          .expect(200);
      }

      await auth(request(server).post('/api/documents/bulk/tags'))
        .send({ ids, add: [keep.id], remove: [drop.id] })
        .expect(201);

      const detail = (await auth(request(server).get(`/api/documents/${first.id}`)).expect(200))
        .body as { tags: { name: string }[] };
      expect(detail.tags.map((tag) => tag.name)).toEqual(['Keep']);

      // Re-sending is a no-op rather than a conflict: skipDuplicates leans on
      // the composite primary key.
      await auth(request(server).post('/api/documents/bulk/tags'))
        .send({ ids, add: [keep.id] })
        .expect(201);

      const again = (await auth(request(server).get(`/api/documents/${first.id}`)).expect(200))
        .body as { tags: { name: string }[] };
      expect(again.tags.map((tag) => tag.name)).toEqual(['Keep']);
    });

    it('moves to the company root with a null folder', async () => {
      const { auth } = await tenant('root');
      const folder = (
        await auth(request(server).post('/api/folders')).send({ name: 'Somewhere' }).expect(201)
      ).body as { id: string };

      const document = await uploadReady(auth);
      await auth(request(server).post('/api/documents/bulk/move'))
        .send({ ids: [document.id], folderId: folder.id })
        .expect(201);

      await auth(request(server).post('/api/documents/bulk/move'))
        .send({ ids: [document.id], folderId: null })
        .expect(201);

      const detail = (await auth(request(server).get(`/api/documents/${document.id}`)).expect(200))
        .body as { folderId: string | null };
      expect(detail.folderId).toBeNull();
    });

    it('rejects an empty selection and an over-large one', async () => {
      const { auth } = await tenant('limits');

      await auth(request(server).post('/api/documents/bulk/delete')).send({ ids: [] }).expect(400);

      await auth(request(server).post('/api/documents/bulk/delete'))
        .send({ ids: Array.from({ length: 201 }, () => randomUUID()) })
        .expect(400);
    });
  });

  describe('permissions', () => {
    /**
     * The reason there is one route per action rather than one endpoint taking
     * an action name: a single route would have to demand the strictest
     * permission of the set, and a Member would lose bulk deletion — which they
     * can do one document at a time.
     */
    it('gates each action on the permission its single-document twin needs', async () => {
      const { auth: owner } = await tenant('perms');

      const roles = (await owner(request(server).get('/api/roles')).expect(200)).body as {
        items: { id: string; name: string }[];
      };
      const memberRole = roles.items.find((role) => role.name === 'Member');

      const invited = (
        await owner(request(server).post('/api/invitations'))
          .send({
            email: `member.${randomUUID().slice(0, 8)}@example.test`,
            roleId: memberRole?.id,
          })
          .expect(201)
      ).body as { link: string };

      const session = (
        await request(server)
          .post('/api/auth/accept-invitation')
          .send({
            token: new URL(invited.link).searchParams.get('token'),
            firstName: 'Mem',
            lastName: 'Ber',
            password: 'correct-horse-battery-staple',
          })
          .expect(201)
      ).body as Session;

      const member: Auth = (req) => req.set('Authorization', `Bearer ${session.accessToken}`);

      const document = await uploadReady(member);

      // documents.delete — a Member has it.
      await member(request(server).post('/api/documents/bulk/delete'))
        .send({ ids: [document.id] })
        .expect(201);

      // documents.restore — a Member does not.
      await member(request(server).post('/api/documents/bulk/restore'))
        .send({ ids: [document.id] })
        .expect(403);
    });
  });

  describe('favourites', () => {
    it('stars, filters, and reports state per person', async () => {
      const { auth: alice } = await tenant('stars');
      const { auth: bob } = await colleagueOf(alice);

      const starred = await uploadReady(alice, 'starred.txt');
      const plain = await uploadReady(alice, 'plain.txt');

      await alice(request(server).post(`/api/documents/${starred.id}/favorite`)).expect(201);

      // Idempotent: a second click on a lit star is not an error.
      await alice(request(server).post(`/api/documents/${starred.id}/favorite`)).expect(201);

      const mine = (await alice(request(server).get('/api/documents?favorite=true')).expect(200))
        .body as { items: DocumentBody[] };
      expect(mine.items.map((item) => item.id)).toEqual([starred.id]);

      const all = (await alice(request(server).get('/api/documents')).expect(200)).body as {
        items: DocumentBody[];
      };
      expect(all.items.find((item) => item.id === starred.id)?.isFavorite).toBe(true);
      expect(all.items.find((item) => item.id === plain.id)?.isFavorite).toBe(false);

      /**
       * The point of the whole model: Bob shares the company and the document,
       * and sees an unstarred row. A favourite is the one document-adjacent
       * thing that is not shared.
       */
      const theirs = (await bob(request(server).get('/api/documents?favorite=true')).expect(200))
        .body as { items: DocumentBody[] };
      expect(theirs.items).toEqual([]);

      const detail = (await bob(request(server).get(`/api/documents/${starred.id}`)).expect(200))
        .body as DocumentBody;
      expect(detail.isFavorite).toBe(false);

      // Unstarring is idempotent too, and only touches the caller's own row.
      await alice(request(server).delete(`/api/documents/${starred.id}/favorite`)).expect(200);
      await alice(request(server).delete(`/api/documents/${starred.id}/favorite`)).expect(200);

      const empty = (await alice(request(server).get('/api/documents?favorite=true')).expect(200))
        .body as { items: DocumentBody[] };
      expect(empty.items).toEqual([]);
    });

    it('404s a trashed document and one from another company', async () => {
      const alice = await tenant('alice');
      const bob = await tenant('bob');

      const document = await uploadReady(alice.auth);

      await bob.auth(request(server).post(`/api/documents/${document.id}/favorite`)).expect(404);

      await alice.auth(request(server).delete(`/api/documents/${document.id}`)).expect(200);
      await alice.auth(request(server).post(`/api/documents/${document.id}/favorite`)).expect(404);
    });

    /** A favourite is private, so it leaves no trace in the company's trail. */
    it('writes nothing to the audit log', async () => {
      const { auth } = await tenant('quiet');
      const document = await uploadReady(auth);

      await auth(request(server).post(`/api/documents/${document.id}/favorite`)).expect(201);

      const trail = (await auth(request(server).get('/api/audit')).expect(200)).body as {
        items: { action: string }[];
      };

      expect(trail.items.filter((entry) => entry.action.includes('favorite'))).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    it('refuses another company every id in a batch', async () => {
      const alice = await tenant('iso-a');
      const bob = await tenant('iso-b');

      const document = await uploadReady(alice.auth);

      const result = (
        await bob
          .auth(request(server).post('/api/documents/bulk/delete'))
          .send({ ids: [document.id] })
          .expect(201)
      ).body as BulkBody;

      // Indistinguishable from an id that never existed — "not yours" would
      // confirm the document is real.
      expect(result.succeeded).toEqual([]);
      expect(result.skipped).toEqual([{ id: document.id, code: 'DOCUMENT_NOT_FOUND' }]);

      const row = await prisma.document.findUnique({ where: { id: document.id } });
      expect(row?.deletedAt).toBeNull();
    });
  });
});
