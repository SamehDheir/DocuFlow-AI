import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { SessionUser } from '../src/auth/auth.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';

/**
 * Versions and archive, end to end.
 *
 * Needs the local stack running — Postgres AND MinIO:
 *
 *   npm run infra:up
 *
 * Run with `npm run test:e2e --workspace=@docuflow/api`.
 *
 * The cross-tenant cases at the bottom are the reason this file exists.
 * DocumentVersion carries no `companyId`, so the tenant guard passes a direct
 * query on it straight through — isolation depends entirely on every lookup
 * going through the parent document, which is a convention no type can enforce.
 */

interface Session {
  accessToken: string;
  user: SessionUser;
}

interface DocumentBody {
  id: string;
  name: string;
  originalName: string;
  mimeType: string;
  size: string;
  status: string;
}

interface VersionBody {
  id: string;
  versionNumber: number;
  size: string;
  note: string | null;
}

interface DetailBody extends DocumentBody {
  versions: VersionBody[];
}

const V1 = 'first draft, version one';
const V2 = 'second draft, quite different';

function accountFor(label: string) {
  const suffix = randomUUID().slice(0, 8);

  return {
    companyName: `Versions ${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label}.${suffix}@example.test`,
    password: 'correct-horse-battery-staple',
  };
}

describe('Document versions and archive (e2e)', () => {
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

    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${session.accessToken}`);

    return { session, auth };
  }

  /**
   * Uploads and then forces the document past the pipeline.
   *
   * The e2e suite runs with QUEUE_WORKER_ENABLED=false, so an upload sits at
   * PROCESSING forever — and a new version, a revert and an archive are all
   * deliberately refused while a worker might still hold the document. Written
   * through PrismaService, which is the raw unguarded client, because this is
   * standing in for infrastructure rather than exercising the API.
   */
  async function uploadReady(
    auth: (req: request.Test) => request.Test,
    body = V1,
    filename = 'draft.txt',
  ): Promise<DocumentBody> {
    const uploaded = (
      await auth(request(server).post('/api/documents'))
        .attach('file', Buffer.from(body), { filename, contentType: 'text/plain' })
        .expect(201)
    ).body as DocumentBody;

    await prisma.document.update({ where: { id: uploaded.id }, data: { status: 'READY' } });

    return uploaded;
  }

  const detail = async (auth: (req: request.Test) => request.Test, id: string) =>
    (await auth(request(server).get(`/api/documents/${id}`)).expect(200)).body as DetailBody;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const scope = { companyId: { in: createdCompanies } };

    // Documents before folders before the company — see documents.e2e-spec.ts
    // for why a company that owns documents cannot be deleted in one statement.
    await prisma.document.deleteMany({ where: scope });
    await prisma.folder.deleteMany({ where: scope });
    await prisma.company.deleteMany({ where: { id: { in: createdCompanies } } });

    await app.close();
  });

  describe('versions', () => {
    it('appends a version, keeps the old bytes, and reverts by appending again', async () => {
      const { auth } = await tenant('append');
      const document = await uploadReady(auth);

      const before = await detail(auth, document.id);
      expect(before.versions).toHaveLength(1);
      const v1 = before.versions[0];

      // --- add version 2 -----------------------------------------------------
      await auth(request(server).post(`/api/documents/${document.id}/versions`))
        .field('note', 'rewrote the summary')
        .attach('file', Buffer.from(V2), { filename: 'draft-2.txt', contentType: 'text/plain' })
        .expect(201);

      await prisma.document.update({ where: { id: document.id }, data: { status: 'READY' } });

      const afterAdd = await detail(auth, document.id);
      expect(afterAdd.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
      expect(afterAdd.size).toBe(String(V2.length));

      // The document now serves the new bytes...
      const current = await auth(
        request(server).get(`/api/documents/${document.id}/download`),
      ).expect(200);
      expect(current.text).toBe(V2);

      // ...while version 1's own object is untouched. Each version points at
      // its own immutable key, which is what makes history real.
      const historical = await auth(
        request(server).get(`/api/documents/${document.id}/versions/${v1.id}/download`),
      ).expect(200);
      expect(historical.text).toBe(V1);

      // --- revert to version 1 ----------------------------------------------
      await auth(request(server).post(`/api/documents/${document.id}/versions/${v1.id}/revert`))
        .send({ note: 'back to the original' })
        .expect(201);

      await prisma.document.update({ where: { id: document.id }, data: { status: 'READY' } });

      const afterRevert = await detail(auth, document.id);

      // THREE versions, not two. A revert appends; it never rewinds, and it
      // never rewrites what was already recorded.
      expect(afterRevert.versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
      expect(afterRevert.originalName).toBe('draft.txt');

      const reverted = await auth(
        request(server).get(`/api/documents/${document.id}/download`),
      ).expect(200);
      expect(reverted.text).toBe(V1);
    });

    it('404s a version id that belongs to a different document', async () => {
      const { auth } = await tenant('mixed');
      const a = await uploadReady(auth);
      const b = await uploadReady(auth);

      const foreign = (await detail(auth, b.id)).versions[0];

      await auth(
        request(server).get(`/api/documents/${a.id}/versions/${foreign.id}/download`),
      ).expect(404);
    });
  });

  describe('archive', () => {
    it('hides the document, refuses writes, and still allows reads', async () => {
      const { auth } = await tenant('archive');
      const document = await uploadReady(auth);

      await auth(request(server).post(`/api/documents/${document.id}/archive`)).expect(201);

      // Gone from the default listing...
      const listed = (await auth(request(server).get('/api/documents')).expect(200)).body as {
        items: DocumentBody[];
      };
      expect(listed.items.map((item) => item.id)).not.toContain(document.id);

      // ...but reachable both ways that are meant to reach it.
      const included = (
        await auth(request(server).get('/api/documents?includeArchived=true')).expect(200)
      ).body as { items: DocumentBody[] };
      expect(included.items.map((item) => item.id)).toContain(document.id);

      const filtered = (
        await auth(request(server).get('/api/documents?status=ARCHIVED')).expect(200)
      ).body as { items: DocumentBody[] };
      expect(filtered.items.map((item) => item.id)).toContain(document.id);

      // Read-only: every write is refused.
      await auth(request(server).patch(`/api/documents/${document.id}`))
        .send({ name: 'renamed' })
        .expect(409);
      await auth(request(server).post(`/api/documents/${document.id}/reprocess`)).expect(409);
      await auth(request(server).post(`/api/documents/${document.id}/versions`))
        .attach('file', Buffer.from(V2), { filename: 'x.txt', contentType: 'text/plain' })
        .expect(409);
      await auth(request(server).post(`/api/documents/${document.id}/archive`)).expect(409);

      // Reading and downloading still work — freezing a record is not sealing
      // it away.
      await auth(request(server).get(`/api/documents/${document.id}`)).expect(200);
      await auth(request(server).get(`/api/documents/${document.id}/download`)).expect(200);

      await auth(request(server).post(`/api/documents/${document.id}/unarchive`)).expect(201);

      const restored = await detail(auth, document.id);
      expect(restored.status).toBe('READY');
    });

    it('drops archived documents from the folder count that opens them', async () => {
      const { auth } = await tenant('counts');

      const folder = (
        await auth(request(server).post('/api/folders')).send({ name: 'Archive box' }).expect(201)
      ).body as { id: string };

      const uploaded = (
        await auth(request(server).post('/api/documents'))
          .field('folderId', folder.id)
          .attach('file', Buffer.from(V1), { filename: 'a.txt', contentType: 'text/plain' })
          .expect(201)
      ).body as DocumentBody;

      await prisma.document.update({ where: { id: uploaded.id }, data: { status: 'READY' } });

      const before = (await auth(request(server).get(`/api/folders/${folder.id}`)).expect(200))
        .body as { documentCount: number };
      expect(before.documentCount).toBe(1);

      await auth(request(server).post(`/api/documents/${uploaded.id}/archive`)).expect(201);

      /**
       * The count has to agree with the list it opens. A badge reading "1" over
       * a folder that shows nothing reads as a counting bug, and the reader has
       * no way to discover the document is merely archived.
       */
      const after = (await auth(request(server).get(`/api/folders/${folder.id}`)).expect(200))
        .body as { documentCount: number };
      expect(after.documentCount).toBe(0);
    });
  });

  /**
   * The point of this file.
   *
   * DocumentVersion has no companyId, so `documentVersion.findFirst({ where: {
   * id } })` would return another tenant's row without complaint. These assert
   * that every route reaches versions through the parent document instead.
   */
  describe('tenant isolation', () => {
    it('refuses another company a version, by either id in the path', async () => {
      const alice = await tenant('alice');
      const bob = await tenant('bob');

      const hers = await uploadReady(alice.auth, 'confidential');
      const version = (await detail(alice.auth, hers.id)).versions[0];

      // Bob's own document, so the document id in the path IS his.
      const his = await uploadReady(bob.auth, 'unrelated');

      // The document is not his: 404 rather than 403, so the response cannot
      // confirm the id exists at all.
      await bob
        .auth(request(server).get(`/api/documents/${hers.id}/versions/${version.id}/download`))
        .expect(404);

      /**
       * The case that actually exercises transitive scoping: Bob owns the
       * document named in the path and supplies HER version id. Only reaching
       * the version through the parent makes this a miss.
       */
      await bob
        .auth(request(server).get(`/api/documents/${his.id}/versions/${version.id}/download`))
        .expect(404);

      await bob
        .auth(request(server).post(`/api/documents/${his.id}/versions/${version.id}/revert`))
        .send({})
        .expect(404);

      // And her document is untouched by any of it.
      const check = await detail(alice.auth, hers.id);
      expect(check.versions).toHaveLength(1);
    });

    it('refuses another company the archive endpoints', async () => {
      const alice = await tenant('alice-archive');
      const bob = await tenant('bob-archive');

      const hers = await uploadReady(alice.auth);

      await bob.auth(request(server).post(`/api/documents/${hers.id}/archive`)).expect(404);

      const check = await detail(alice.auth, hers.id);
      expect(check.status).toBe('READY');
    });
  });
});
