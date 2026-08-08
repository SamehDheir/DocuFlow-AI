import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { SessionUser } from '../src/auth/auth.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';

/**
 * Tags, end to end.
 *
 * Needs the local stack running — Postgres AND MinIO:
 *
 *   npm run infra:up
 *
 * `Tag` and `DocumentTag` shipped in the very first migration and had no code
 * behind them until v4. The isolation cases at the bottom matter for the same
 * reason as the version ones: DocumentTag has no companyId, so the tenant guard
 * cannot help and every path has to go through the parent document.
 */

interface Session {
  accessToken: string;
  user: SessionUser;
}

interface TagBody {
  id: string;
  name: string;
  color: string | null;
  documentCount?: number;
}

interface DocumentBody {
  id: string;
  name: string;
  status: string;
}

type Auth = (req: request.Test) => request.Test;

function accountFor(label: string) {
  const suffix = randomUUID().slice(0, 8);

  return {
    companyName: `Tags ${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label}.${suffix}@example.test`,
    password: 'correct-horse-battery-staple',
  };
}

describe('Tags (e2e)', () => {
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

  /**
   * A second account in the same company, holding the Member role.
   *
   * Registration always creates a NEW company and makes the registrant Owner,
   * so an invitation is the only way to produce a colleague who is not one.
   */
  async function memberOf(owner: Auth): Promise<Auth> {
    const roles = (await owner(request(server).get('/api/roles')).expect(200)).body as {
      items: { id: string; name: string }[];
    };
    const member = roles.items.find((role) => role.name === 'Member');

    const invited = (
      await owner(request(server).post('/api/invitations'))
        .send({ email: `member.${randomUUID().slice(0, 8)}@example.test`, roleId: member?.id })
        .expect(201)
    ).body as { link: string };

    const token = new URL(invited.link).searchParams.get('token');

    const session = (
      await request(server)
        .post('/api/auth/accept-invitation')
        .send({
          token,
          firstName: 'Mem',
          lastName: 'Ber',
          password: 'correct-horse-battery-staple',
        })
        .expect(201)
    ).body as Session;

    return (req) => req.set('Authorization', `Bearer ${session.accessToken}`);
  }

  async function uploadReady(auth: Auth, body = 'tagged contents'): Promise<DocumentBody> {
    const uploaded = (
      await auth(request(server).post('/api/documents'))
        .attach('file', Buffer.from(body), { filename: 'doc.txt', contentType: 'text/plain' })
        .expect(201)
    ).body as DocumentBody;

    // The e2e suite runs producer-only, so nothing would otherwise move this
    // past PROCESSING — and search only returns READY documents.
    await prisma.document.update({ where: { id: uploaded.id }, data: { status: 'READY' } });

    return uploaded;
  }

  /**
   * The same, plus the extracted text search actually reads.
   *
   * With the worker disabled there is no `document_metadata` row at all, so
   * `search_vector` is NULL and a content search matches nothing whatever the
   * tag filter does. Writing the text directly fires the same trigger the
   * pipeline would, which is what makes the tag predicate testable here rather
   * than only against a live worker.
   */
  async function uploadSearchable(auth: Auth, text: string): Promise<DocumentBody> {
    const uploaded = await uploadReady(auth, text);

    await prisma.documentMetadata.upsert({
      where: { documentId: uploaded.id },
      create: { documentId: uploaded.id, extractedText: text },
      update: { extractedText: text },
    });

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

  describe('the vocabulary', () => {
    it('creates, renames, lists with counts, and deletes', async () => {
      const { auth } = await tenant('crud');

      const tag = (
        await auth(request(server).post('/api/tags'))
          .send({ name: 'Contracts', color: 'accent' })
          .expect(201)
      ).body as TagBody;

      expect(tag.color).toBe('accent');

      // Names are unique per company.
      await auth(request(server).post('/api/tags')).send({ name: 'Contracts' }).expect(409);

      await auth(request(server).patch(`/api/tags/${tag.id}`))
        .send({ name: 'Signed contracts' })
        .expect(200);

      const document = await uploadReady(auth);
      await auth(request(server).put(`/api/documents/${document.id}/tags`))
        .send({ tagIds: [tag.id] })
        .expect(200);

      const listed = (await auth(request(server).get('/api/tags')).expect(200)).body as TagBody[];
      expect(listed).toHaveLength(1);
      expect(listed[0].name).toBe('Signed contracts');
      expect(listed[0].documentCount).toBe(1);

      /**
       * A tag in use is still deletable, unlike an occupied folder: a folder is
       * where a document lives, a tag is only a label on it.
       */
      const removed = (await auth(request(server).delete(`/api/tags/${tag.id}`)).expect(200))
        .body as { unlabelled: number };
      expect(removed.unlabelled).toBe(1);

      await expect(
        auth(request(server).get('/api/tags'))
          .expect(200)
          .then((res) => res.body as TagBody[]),
      ).resolves.toEqual([]);
    });
  });

  describe('applying tags', () => {
    it('replaces the whole set, filters the list, and filters search', async () => {
      const { auth } = await tenant('apply');

      const red = (await auth(request(server).post('/api/tags')).send({ name: 'Red' }).expect(201))
        .body as TagBody;
      const blue = (
        await auth(request(server).post('/api/tags')).send({ name: 'Blue' }).expect(201)
      ).body as TagBody;

      const tagged = await uploadSearchable(auth, 'quarterly revenue projections');
      const untagged = await uploadSearchable(auth, 'quarterly revenue projections');

      await auth(request(server).put(`/api/documents/${tagged.id}/tags`))
        .send({ tagIds: [red.id, blue.id] })
        .expect(200);

      const detail = (await auth(request(server).get(`/api/documents/${tagged.id}`)).expect(200))
        .body as { tags: TagBody[] };
      expect(detail.tags.map((entry) => entry.name)).toEqual(['Blue', 'Red']);

      // Whole-set PUT: sending only Red drops Blue rather than merging.
      const after = (
        await auth(request(server).put(`/api/documents/${tagged.id}/tags`))
          .send({ tagIds: [red.id] })
          .expect(200)
      ).body as TagBody[];
      expect(after.map((entry) => entry.name)).toEqual(['Red']);

      // The list filter.
      const listed = (await auth(request(server).get(`/api/documents?tagId=${red.id}`)).expect(200))
        .body as { items: DocumentBody[] };
      expect(listed.items.map((item) => item.id)).toEqual([tagged.id]);
      expect(listed.items.map((item) => item.id)).not.toContain(untagged.id);

      // Both documents match the query...
      const all = (await auth(request(server).get('/api/search?q=quarterly')).expect(200)).body as {
        items: DocumentBody[];
      };
      expect(all.items.map((item) => item.id).sort()).toEqual([tagged.id, untagged.id].sort());

      // ...and the tag narrows it. This is the one raw-SQL path in the system,
      // where the tenant predicate is written by hand rather than injected.
      const found = (
        await auth(request(server).get(`/api/search?q=quarterly&tagId=${red.id}`)).expect(200)
      ).body as { items: DocumentBody[] };
      expect(found.items.map((item) => item.id)).toEqual([tagged.id]);
    });

    it('404s an unknown tag rather than surfacing a constraint error', async () => {
      const { auth } = await tenant('unknown');
      const document = await uploadReady(auth);

      await auth(request(server).put(`/api/documents/${document.id}/tags`))
        .send({ tagIds: [randomUUID()] })
        .expect(404);
    });
  });

  describe('permissions', () => {
    /**
     * The split this slice exists to make: labelling a document is ordinary
     * document work, but inventing a label the whole company then sees — and
     * renaming one, which relabels every document carrying it — is not.
     */
    it('lets a Member apply tags but not manage the vocabulary', async () => {
      const { auth: owner } = await tenant('perms');
      const member = await memberOf(owner);

      const tag = (
        await owner(request(server).post('/api/tags')).send({ name: 'Shared' }).expect(201)
      ).body as TagBody;

      // tags.read — a Member has it.
      await member(request(server).get('/api/tags')).expect(200);

      // documents.update — a Member has it, so applying works.
      const document = await uploadReady(member);
      await member(request(server).put(`/api/documents/${document.id}/tags`))
        .send({ tagIds: [tag.id] })
        .expect(200);

      // tags.manage — a Member does not have it.
      await member(request(server).post('/api/tags')).send({ name: 'Mine' }).expect(403);
      await member(request(server).patch(`/api/tags/${tag.id}`))
        .send({ name: 'Renamed' })
        .expect(403);
      await member(request(server).delete(`/api/tags/${tag.id}`)).expect(403);
    });
  });

  describe('tenant isolation', () => {
    it('refuses another company a tag id, and never leaks the vocabulary', async () => {
      const alice = await tenant('alice');
      const bob = await tenant('bob');

      const hers = (
        await alice.auth(request(server).post('/api/tags')).send({ name: 'Private' }).expect(201)
      ).body as TagBody;

      // Her vocabulary is invisible to him.
      const his = (await bob.auth(request(server).get('/api/tags')).expect(200)).body as TagBody[];
      expect(his).toEqual([]);

      /**
       * The case that exercises the guard: Bob's own document, her tag id. The
       * tenant-scoped read resolves nothing, so it is a 404 — not a foreign-key
       * violation surfacing as a 500, and certainly not a successful write.
       */
      const document = await uploadReady(bob.auth);
      await bob
        .auth(request(server).put(`/api/documents/${document.id}/tags`))
        .send({ tagIds: [hers.id] })
        .expect(404);

      await bob
        .auth(request(server).patch(`/api/tags/${hers.id}`))
        .send({ name: 'Stolen' })
        .expect(404);
      await bob.auth(request(server).delete(`/api/tags/${hers.id}`)).expect(404);

      // Hers is untouched by any of it.
      const check = (await alice.auth(request(server).get('/api/tags')).expect(200))
        .body as TagBody[];
      expect(check.map((tag) => tag.name)).toEqual(['Private']);
    });
  });
});
