import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { SessionUser } from '../src/auth/auth.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';

/**
 * Needs Postgres and MinIO running:
 *
 *   npm run infra:up
 *
 * Run with `npm run test:e2e --workspace=@docuflow/api`.
 */

interface Session {
  accessToken: string;
  user: SessionUser;
}

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  createdAt: string;
  user: { id: string; firstName: string; lastName: string } | null;
}

interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n%docuflow audit fixture\n');

function accountFor(label: string) {
  const suffix = randomUUID().slice(0, 8);

  return {
    companyName: `Audit ${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label}.${suffix}@example.test`,
    password: 'correct-horse-battery-staple',
  };
}

describe('Audit (e2e)', () => {
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

  function uploadTo(auth: (req: request.Test) => request.Test, filename = 'audited.pdf') {
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
    // Documents before folders before company — see the note in
    // documents.e2e-spec.ts; the User references are Restrict by default.
    const scope = { companyId: { in: createdCompanies } };

    await prisma.document.deleteMany({ where: scope });
    await prisma.folder.deleteMany({ where: scope });
    await prisma.company.deleteMany({ where: { id: { in: createdCompanies } } });

    await app.close();
  });

  it('records the trail of a full document lifecycle, newest first', async () => {
    const { session, auth } = await tenant('trail');

    const uploaded = (await uploadTo(auth).expect(201)).body as { id: string };
    await auth(request(server).patch(`/api/documents/${uploaded.id}`))
      .send({ name: 'renamed.pdf' })
      .expect(200);
    await auth(request(server).delete(`/api/documents/${uploaded.id}`)).expect(200);
    await auth(request(server).post(`/api/documents/${uploaded.id}/restore`)).expect(201);

    const page = (await auth(request(server).get('/api/audit')).expect(200)).body as AuditPage;

    const actions = page.items.map((entry) => entry.action);

    // Reverse chronological: the restore just performed leads.
    expect(actions[0]).toBe('document.restore');
    expect(actions).toEqual(
      expect.arrayContaining([
        'document.restore',
        'document.delete',
        'document.rename',
        'document.upload',
        'auth.register',
      ]),
    );

    // The actor is resolved through the relation, not left as a bare id.
    expect(page.items[0].user).toMatchObject({ id: session.user.id, firstName: 'Test' });
    expect(page.items[0].entityId).toBe(uploaded.id);
  });

  it("never leaks another company's entries", async () => {
    const alpha = await tenant('alpha');
    const beta = await tenant('beta');

    const alphaDoc = (await uploadTo(alpha.auth, 'alpha.pdf').expect(201)).body as { id: string };

    const page = (await beta.auth(request(server).get('/api/audit')).expect(200)).body as AuditPage;

    // Beta sees its own registration and nothing of alpha's.
    expect(page.items.every((entry) => entry.entityId !== alphaDoc.id)).toBe(true);
    expect(page.items.some((entry) => entry.action === 'document.upload')).toBe(false);
    expect(page.items.some((entry) => entry.action === 'auth.register')).toBe(true);
  });

  it('pages with a cursor without repeating an entry', async () => {
    const { auth } = await tenant('paging');

    // Registration plus three uploads is enough to need a second page at
    // limit=2, and enough to notice an off-by-one at the boundary.
    await uploadTo(auth, 'one.pdf').expect(201);
    await uploadTo(auth, 'two.pdf').expect(201);
    await uploadTo(auth, 'three.pdf').expect(201);

    const first = (await auth(request(server).get('/api/audit?limit=2')).expect(200))
      .body as AuditPage;

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1].id);

    const second = (
      await auth(request(server).get(`/api/audit?limit=2&cursor=${first.nextCursor}`)).expect(200)
    ).body as AuditPage;

    const seen = new Set(first.items.map((entry) => entry.id));
    expect(second.items.some((entry) => seen.has(entry.id))).toBe(false);
  });

  it('filters by action and by entity type', async () => {
    const { auth } = await tenant('filters');

    await auth(request(server).post('/api/folders')).send({ name: 'Filtered' }).expect(201);
    await uploadTo(auth, 'filtered.pdf').expect(201);

    const byAction = (
      await auth(request(server).get('/api/audit?action=folder.create')).expect(200)
    ).body as AuditPage;

    expect(byAction.items).not.toHaveLength(0);
    expect(byAction.items.every((entry) => entry.action === 'folder.create')).toBe(true);

    const byType = (await auth(request(server).get('/api/audit?entityType=Document')).expect(200))
      .body as AuditPage;

    expect(byType.items).not.toHaveLength(0);
    expect(byType.items.every((entry) => entry.entityType === 'Document')).toBe(true);
  });

  it('lists only the actions this company has actually recorded', async () => {
    const { auth } = await tenant('actions');

    await uploadTo(auth, 'listed.pdf').expect(201);

    const actions = (await auth(request(server).get('/api/audit/actions')).expect(200))
      .body as string[];

    expect(actions).toEqual(expect.arrayContaining(['auth.register', 'document.upload']));
    // Nothing has been deleted in this company, so the menu must not offer it.
    expect(actions).not.toContain('document.delete');
  });

  it('rejects a limit above the maximum rather than silently clamping it', async () => {
    const { auth } = await tenant('limit');

    await auth(request(server).get('/api/audit?limit=101')).expect(400);
  });

  it('refuses a role that does not hold audit.read', async () => {
    // Member is the default role without audit.read — Owner and Admin both
    // hold it, so the permission is the only thing separating them here.
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

    await auth(request(server).get('/api/audit')).expect(200);

    await prisma.userRole.deleteMany({ where: { userId: session.user.id } });
    await prisma.userRole.create({ data: { userId: session.user.id, roleId: member.id } });

    const refused = await auth(request(server).get('/api/audit')).expect(403);
    expect((refused.body as { code: string }).code).toBe('PERMISSION_DENIED');

    // Promoted back, the same call succeeds — proving the 403 was the
    // permission and not something incidental.
    await prisma.userRole.deleteMany({ where: { userId: session.user.id } });
    await prisma.userRole.create({ data: { userId: session.user.id, roleId: owner.id } });

    await auth(request(server).get('/api/audit')).expect(200);
  });

  it('requires authentication at all', async () => {
    await request(server).get('/api/audit').expect(401);
  });
});
