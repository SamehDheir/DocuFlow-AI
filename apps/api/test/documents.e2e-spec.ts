import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { SessionUser } from '../src/auth/auth.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';

/**
 * Needs the local stack running — Postgres AND MinIO:
 *
 *   npm run infra:up
 *
 * Run with `npm run test:e2e --workspace=@docuflow/api`.
 */

interface Session {
  accessToken: string;
  user: SessionUser;
}

interface DocumentBody {
  id: string;
  name: string;
  size: string;
  status: string;
  folderId: string | null;
  deletedAt: string | null;
}

interface FolderBody {
  id: string;
  name: string;
  parentId: string | null;
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n%docuflow test fixture\n');

function accountFor(label: string) {
  const suffix = randomUUID().slice(0, 8);

  return {
    companyName: `Docs ${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label}.${suffix}@example.test`,
    password: 'correct-horse-battery-staple',
  };
}

describe('Documents (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let server: App;

  const createdCompanies: string[] = [];

  /** A registered company with an Owner, who holds every permission. */
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

  function uploadTo(auth: (req: request.Test) => request.Test, filename = 'report.pdf') {
    return auth(request(server).post('/api/documents')).attach('file', PDF_BYTES, {
      filename,
      contentType: 'application/pdf',
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const scope = { companyId: { in: createdCompanies } };

    /**
     * Deleted in dependency order, NOT by cascading from Company.
     *
     * `Document.owner`, `DocumentVersion.uploadedBy` and `Folder.createdBy` all
     * reference User without an onDelete rule, so Prisma defaults them to
     * Restrict. Deleting a Company cascades to its users, and those Restricts
     * then block it — meaning a company that owns documents cannot be deleted
     * in one statement at all. Clearing the documents first releases the
     * references, and the Company delete then cascades users, roles, tokens and
     * audit rows as usual.
     *
     * Worth knowing beyond this test: any future account-closure or
     * data-retention flow has to delete in this order too.
     */
    await prisma.document.deleteMany({ where: scope });
    await prisma.folder.deleteMany({ where: scope });
    await prisma.company.deleteMany({ where: { id: { in: createdCompanies } } });

    // MinIO objects outlive the run; acceptable for a dev bucket.
    await app.close();
  });

  describe('the full v1 lifecycle', () => {
    it('creates a folder, uploads into it, lists, downloads, deletes and restores', async () => {
      const { auth } = await tenant('lifecycle');

      const folder = (
        await auth(request(server).post('/api/folders')).send({ name: 'Contracts' }).expect(201)
      ).body as FolderBody;

      const uploaded = (await uploadTo(auth).field('folderId', folder.id).expect(201))
        .body as DocumentBody;

      expect(uploaded.status).toBe('READY');
      expect(uploaded.folderId).toBe(folder.id);
      // BigInt is serialised as a string, or JSON.stringify throws.
      expect(uploaded.size).toBe(String(PDF_BYTES.length));

      const listed = (await auth(request(server).get('/api/documents')).expect(200)).body as {
        items: DocumentBody[];
        nextCursor: string | null;
      };
      expect(listed.items.map((item) => item.id)).toContain(uploaded.id);

      const downloaded = await auth(
        request(server).get(`/api/documents/${uploaded.id}/download`),
      ).expect(200);
      expect(downloaded.body).toEqual(PDF_BYTES);
      expect(downloaded.headers['content-disposition']).toContain('attachment');

      await auth(request(server).delete(`/api/documents/${uploaded.id}`)).expect(200);

      // Gone from the default listing, present in the trash.
      const afterDelete = (await auth(request(server).get('/api/documents')).expect(200)).body as {
        items: DocumentBody[];
      };
      expect(afterDelete.items.map((item) => item.id)).not.toContain(uploaded.id);

      const trashed = (
        await auth(request(server).get('/api/documents').query({ trash: 'true' })).expect(200)
      ).body as { items: DocumentBody[] };
      expect(trashed.items.map((item) => item.id)).toContain(uploaded.id);

      // The row survived, because Restore is a v1 feature.
      const restored = (
        await auth(request(server).post(`/api/documents/${uploaded.id}/restore`)).expect(201)
      ).body as DocumentBody;
      expect(restored.deletedAt).toBeNull();
      expect(restored.status).toBe('READY');
    });

    it('preserves a non-Latin filename through upload and download', async () => {
      /**
       * multer defaults `defParamCharset` to latin1 and hands it to busboy, so
       * an Arabic filename used to arrive decoded byte-for-byte as Western
       * European text — `تقرير.pdf` persisted as `ØªÙ‚Ø±ÙŠØ±.pdf`. The product
       * ships in Arabic, so this is a first-class case rather than an edge one.
       */
      const { auth } = await tenant('arabic');
      const name = 'تقرير-سنوي.pdf';

      const uploaded = (
        await auth(request(server).post('/api/documents'))
          .attach('file', PDF_BYTES, { filename: name, contentType: 'application/pdf' })
          .expect(201)
      ).body as DocumentBody & { originalName: string; extension: string };

      expect(uploaded.originalName).toBe(name);
      expect(uploaded.name).toBe(name);
      expect(uploaded.extension).toBe('pdf');

      // And it survives the round trip back out through Content-Disposition,
      // which RFC 5987-encodes anything outside ASCII.
      const downloaded = await auth(
        request(server).get(`/api/documents/${uploaded.id}/download`),
      ).expect(200);

      const disposition = downloaded.headers['content-disposition'];
      expect(disposition).toContain("filename*=UTF-8''");
      expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(name);
    });

    it('reports storage usage for the dashboard', async () => {
      const { auth } = await tenant('stats');
      await uploadTo(auth).expect(201);

      const stats = (await auth(request(server).get('/api/documents/stats')).expect(200)).body as {
        documents: number;
        storageBytes: string;
      };

      expect(stats.documents).toBe(1);
      expect(stats.storageBytes).toBe(String(PDF_BYTES.length));
    });

    it('counts the documents in each folder for the sidebar', async () => {
      const { auth } = await tenant('counts');

      const contracts = (
        await auth(request(server).post('/api/folders')).send({ name: 'Contracts' }).expect(201)
      ).body as FolderBody;
      const empty = (
        await auth(request(server).post('/api/folders')).send({ name: 'Empty' }).expect(201)
      ).body as FolderBody;

      const first = (await uploadTo(auth, 'one.pdf').field('folderId', contracts.id).expect(201))
        .body as DocumentBody;
      await uploadTo(auth, 'two.pdf').field('folderId', contracts.id).expect(201);

      const listed = (await auth(request(server).get('/api/folders')).expect(200))
        .body as (FolderBody & { documentCount: number })[];

      expect(listed.find((row) => row.id === contracts.id)?.documentCount).toBe(2);
      // Present with a zero rather than omitted — an empty folder is still a folder.
      expect(listed.find((row) => row.id === empty.id)?.documentCount).toBe(0);

      // Trashing one decrements it, since deletedAt is filtered explicitly.
      await auth(request(server).delete(`/api/documents/${first.id}`)).expect(200);

      const afterDelete = (await auth(request(server).get('/api/folders')).expect(200))
        .body as (FolderBody & { documentCount: number })[];

      expect(afterDelete.find((row) => row.id === contracts.id)?.documentCount).toBe(1);
    });

    it('refuses to delete a folder that still holds a document', async () => {
      const { auth } = await tenant('nonempty');

      const folder = (
        await auth(request(server).post('/api/folders')).send({ name: 'Legal' }).expect(201)
      ).body as FolderBody;

      await uploadTo(auth).field('folderId', folder.id).expect(201);

      const refused = await auth(request(server).delete(`/api/folders/${folder.id}`)).expect(409);
      expect((refused.body as { code: string }).code).toBe('FOLDER_NOT_EMPTY');
    });

    it('rejects a file type outside the allowlist', async () => {
      const { auth } = await tenant('mime');

      const rejected = await auth(request(server).post('/api/documents'))
        .attach('file', Buffer.from('MZ'), {
          filename: 'payload.exe',
          contentType: 'application/x-msdownload',
        })
        .expect(400);

      expect((rejected.body as { code: string }).code).toBe('MIME_NOT_ALLOWED');
    });
  });

  describe('tenant isolation', () => {
    /**
     * The reason the guard exists.
     *
     * Two companies, each with a document and a folder, and every documents
     * endpoint asked to reach across. A regression here is the highest-severity
     * bug class this system has (SECURITY.md), and it is silent — nothing else
     * in the suite would notice.
     */
    it('hides one company’s documents and folders from another', async () => {
      const alpha = await tenant('alpha');
      const beta = await tenant('beta');

      const alphaFolder = (
        await alpha.auth(request(server).post('/api/folders')).send({ name: 'Alpha' }).expect(201)
      ).body as FolderBody;

      const alphaDocument = (await uploadTo(alpha.auth, 'alpha.pdf').expect(201))
        .body as DocumentBody;

      await uploadTo(beta.auth, 'beta.pdf').expect(201);

      // Beta's listing shows only Beta's own document.
      const betaList = (await beta.auth(request(server).get('/api/documents')).expect(200))
        .body as { items: DocumentBody[] };
      expect(betaList.items).toHaveLength(1);
      expect(betaList.items.map((item) => item.id)).not.toContain(alphaDocument.id);

      // Every by-id route is a 404, not a 403 — a different company's record is
      // indistinguishable from one that does not exist, so nothing leaks.
      await beta.auth(request(server).get(`/api/documents/${alphaDocument.id}`)).expect(404);
      await beta
        .auth(request(server).get(`/api/documents/${alphaDocument.id}/download`))
        .expect(404);
      await beta
        .auth(request(server).get(`/api/documents/${alphaDocument.id}/preview`))
        .expect(404);
      await beta
        .auth(request(server).patch(`/api/documents/${alphaDocument.id}`))
        .send({ name: 'stolen' })
        .expect(404);
      await beta.auth(request(server).delete(`/api/documents/${alphaDocument.id}`)).expect(404);
      await beta
        .auth(request(server).post(`/api/documents/${alphaDocument.id}/restore`))
        .expect(404);

      await beta.auth(request(server).get(`/api/folders/${alphaFolder.id}`)).expect(404);
      await beta.auth(request(server).delete(`/api/folders/${alphaFolder.id}`)).expect(404);

      // Alpha's document is untouched by all of that.
      const alphaAfter = (
        await alpha.auth(request(server).get(`/api/documents/${alphaDocument.id}`)).expect(200)
      ).body as DocumentBody;
      expect(alphaAfter.name).toBe('alpha.pdf');
      expect(alphaAfter.deletedAt).toBeNull();
    });

    it('refuses to file a document into another company’s folder', async () => {
      const alpha = await tenant('alpha-folder');
      const beta = await tenant('beta-folder');

      const alphaFolder = (
        await alpha.auth(request(server).post('/api/folders')).send({ name: 'Alpha' }).expect(201)
      ).body as FolderBody;

      // Naming another tenant's folder must not place the document there, and
      // must not confirm the folder exists either.
      await uploadTo(beta.auth).field('folderId', alphaFolder.id).expect(404);
    });

    it('ignores a client-supplied company id', async () => {
      // The tenant comes from the JWT. forbidNonWhitelisted rejects the attempt
      // outright rather than silently dropping the field.
      const { auth } = await tenant('injection');

      await auth(request(server).post('/api/folders'))
        .send({ name: 'Injected', companyId: randomUUID() })
        .expect(400);
    });
  });

  describe('authorisation', () => {
    it('requires authentication', async () => {
      await request(server).get('/api/documents').expect(401);
      await request(server).get('/api/folders').expect(401);
    });

    it('rejects a document id that is not a uuid before touching the database', async () => {
      const { auth } = await tenant('uuid');

      await auth(request(server).get('/api/documents/not-a-uuid')).expect(400);
    });

    it('refuses an action the role does not grant', async () => {
      // Member holds documents.delete but NOT documents.restore, so the two
      // sides of the same feature are genuinely separable.
      const { session, auth } = await tenant('member');

      const member = await prisma.role.findFirst({
        where: { companyId: session.user.companyId, name: 'Member' },
        select: { id: true },
      });
      const owner = await prisma.role.findFirst({
        where: { companyId: session.user.companyId, name: 'Owner' },
        select: { id: true },
      });

      if (!member || !owner) throw new Error('Default roles were not created');

      const uploaded = (await uploadTo(auth).expect(201)).body as DocumentBody;
      await auth(request(server).delete(`/api/documents/${uploaded.id}`)).expect(200);

      // Demote to Member, then try to restore.
      await prisma.userRole.deleteMany({ where: { userId: session.user.id } });
      await prisma.userRole.create({ data: { userId: session.user.id, roleId: member.id } });

      const refused = await auth(
        request(server).post(`/api/documents/${uploaded.id}/restore`),
      ).expect(403);
      expect((refused.body as { code: string }).code).toBe('PERMISSION_DENIED');

      // Promote back, and the same call succeeds — proving the 403 was the
      // permission and not something incidental.
      await prisma.userRole.deleteMany({ where: { userId: session.user.id } });
      await prisma.userRole.create({ data: { userId: session.user.id, roleId: owner.id } });

      await auth(request(server).post(`/api/documents/${uploaded.id}/restore`)).expect(201);
    });
  });
});
