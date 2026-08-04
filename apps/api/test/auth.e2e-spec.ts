import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { SessionUser } from '../src/auth/auth.types';
import { REFRESH_COOKIE } from '../src/auth/token.service';
import { TenantContextService } from '../src/common/tenant/tenant-context.service';
import { PERMISSIONS } from '../src/permissions/permissions.catalogue';
import { TENANT_PRISMA } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import type { TenantGuardedClient } from '../src/prisma/tenant-guard';
import { createTestApp } from './create-test-app';

/**
 * Needs the local stack running:
 *
 *   npm run infra:up
 *
 * Run with `npm run test:e2e --workspace=@docuflow/api`. Not part of
 * `npm test`, whose rootDir is src/.
 */

interface Session {
  accessToken: string;
  user: SessionUser;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function accountFor(label: string) {
  const suffix = randomUUID().slice(0, 8);

  return {
    companyName: `Test ${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label}.${suffix}@example.test`,
    password: 'correct-horse-battery-staple',
  };
}

function refreshCookie(response: request.Response): string {
  const header = response.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((value) => value.startsWith(`${REFRESH_COOKIE}=`));

  if (!cookie) {
    throw new Error('Response carried no refresh cookie');
  }

  return cookie;
}

describe('Auth (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let server: App;

  const createdCompanies: string[] = [];

  async function register(account: ReturnType<typeof accountFor>) {
    const response = await request(server).post('/api/auth/register').send(account).expect(201);
    const body = response.body as Session;

    createdCompanies.push(body.user.companyId);

    return { response, body };
  }

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Cascades take the users, roles, tokens, and audit rows with them.
    await prisma.company.deleteMany({ where: { id: { in: createdCompanies } } });
    await app.close();
  });

  describe('POST /api/auth/register', () => {
    it('creates a tenant and returns a session', async () => {
      const account = accountFor('register');
      const { response, body } = await register(account);

      expect(body.accessToken).toEqual(expect.any(String));
      expect(body.user).toMatchObject({
        email: account.email,
        firstName: account.firstName,
        lastName: account.lastName,
      });
      expect(body.user.id).toMatch(UUID);
      expect(body.user.companyId).toMatch(UUID);

      const cookie = refreshCookie(response);
      // The long-lived half must be unreachable from script and never sent on
      // document or upload requests.
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/api/auth');
    });

    it('materialises the default roles and makes the registrant Owner', async () => {
      const { body } = await register(accountFor('roles'));

      const roles = await prisma.role.findMany({ where: { companyId: body.user.companyId } });
      expect(roles.map((role) => role.name).sort()).toEqual(['Admin', 'Member', 'Owner']);

      const owner = roles.find((role) => role.name === 'Owner');
      const granted = await prisma.userRole.findMany({ where: { userId: body.user.id } });
      expect(granted).toEqual([{ userId: body.user.id, roleId: owner?.id }]);
    });

    it('records the registration in the audit trail', async () => {
      const { body } = await register(accountFor('audit'));

      const entries = await prisma.auditLog.findMany({ where: { companyId: body.user.companyId } });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'auth.register',
        entityType: 'Company',
        userId: body.user.id,
      });
    });

    it('rejects a password below the policy', async () => {
      await request(server)
        .post('/api/auth/register')
        .send({ ...accountFor('weak'), password: 'short' })
        .expect(400);
    });

    it('refuses a client-supplied companyId outright', async () => {
      // Accepting a tenant from the request body is the obvious route to
      // cross-tenant writes, so the pipe rejects unknown properties rather than
      // dropping them silently.
      await request(server)
        .post('/api/auth/register')
        .send({ ...accountFor('injected'), companyId: randomUUID() })
        .expect(400);
    });

    it('refuses a second company for an address that already has an account', async () => {
      const account = accountFor('duplicate');
      await register(account);

      const response = await request(server)
        .post('/api/auth/register')
        .send({ ...accountFor('duplicate'), email: account.email })
        .expect(409);

      // The form highlights the offending field, so the message is not enough
      // on its own — AuthError reads `errors` to do it.
      expect((response.body as { errors: Record<string, string> }).errors).toHaveProperty('email');

      const users = await prisma.user.findMany({ where: { email: account.email } });
      expect(users).toHaveLength(1);
    });

    it('treats a differently-cased address as the same account', async () => {
      const account = accountFor('casedup');
      await register(account);

      await request(server)
        .post('/api/auth/register')
        .send({ ...accountFor('casedup'), email: account.email.toUpperCase() })
        .expect(409);
    });

    it('keeps slugs unique when two companies share a name', async () => {
      const first = accountFor('slug');
      const second = { ...accountFor('slug'), companyName: first.companyName };

      const a = await register(first);
      const b = await register(second);

      const companies = await prisma.company.findMany({
        where: { id: { in: [a.body.user.companyId, b.body.user.companyId] } },
      });

      expect(companies[0].slug).not.toBe(companies[1].slug);
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns a session for the right password', async () => {
      const account = accountFor('login');
      await register(account);

      const response = await request(server)
        .post('/api/auth/login')
        .send({ email: account.email, password: account.password })
        .expect(200);

      expect((response.body as Session).user.email).toBe(account.email);
      expect(refreshCookie(response)).toContain('HttpOnly');
    });

    it('accepts the address in any casing', async () => {
      const account = accountFor('casing');
      await register(account);

      await request(server)
        .post('/api/auth/login')
        .send({ email: account.email.toUpperCase(), password: account.password })
        .expect(200);
    });

    it('answers a wrong password and an unknown address identically', async () => {
      const account = accountFor('generic');
      await register(account);

      const wrongPassword = await request(server)
        .post('/api/auth/login')
        .send({ email: account.email, password: 'definitely-not-the-password' })
        .expect(401);

      const unknownEmail = await request(server)
        .post('/api/auth/login')
        .send({ email: `nobody.${randomUUID()}@example.test`, password: account.password })
        .expect(401);

      // Any difference here is a free membership oracle.
      expect((wrongPassword.body as { message: string }).message).toBe(
        (unknownEmail.body as { message: string }).message,
      );
    });

    it('records the failed attempt against the account', async () => {
      const account = accountFor('failed');
      const { body } = await register(account);

      await request(server)
        .post('/api/auth/login')
        .send({ email: account.email, password: 'wrong-password-entirely' })
        .expect(401);

      const entries = await prisma.auditLog.findMany({
        where: { companyId: body.user.companyId, action: 'auth.login_failed' },
      });
      expect(entries).toHaveLength(1);
    });

    it('turns away a deactivated account', async () => {
      const account = accountFor('inactive');
      const { body } = await register(account);

      await prisma.user.update({ where: { id: body.user.id }, data: { isActive: false } });

      await request(server)
        .post('/api/auth/login')
        .send({ email: account.email, password: account.password })
        .expect(401);
    });
  });

  describe('GET /api/auth/me', () => {
    it('hydrates the session with roles and permissions', async () => {
      const { body } = await register(accountFor('me'));

      const response = await request(server)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);

      const me = response.body as {
        id: string;
        roles: string[];
        permissions: string[];
        company: { slug: string };
      };

      expect(me.id).toBe(body.user.id);
      expect(me.roles).toEqual(['Owner']);
      expect(me.permissions).toHaveLength(PERMISSIONS.length);
      expect(me.company.slug).toEqual(expect.any(String));
    });

    it('rejects an anonymous request', async () => {
      await request(server).get('/api/auth/me').expect(401);
    });

    it('rejects a token signed with another key', async () => {
      const forged = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(
          JSON.stringify({ sub: randomUUID(), company_id: randomUUID(), roles: ['Owner'] }),
        ).toString('base64url'),
        'not-a-real-signature',
      ].join('.');

      await request(server)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('rotates the cookie and issues a fresh access token', async () => {
      const { response } = await register(accountFor('refresh'));
      const original = refreshCookie(response);

      const rotated = await request(server)
        .post('/api/auth/refresh')
        .set('Cookie', original)
        .expect(200);

      expect(refreshCookie(rotated)).not.toBe(original);
      expect((rotated.body as Session).accessToken).toEqual(expect.any(String));
    });

    it('rejects a request with no cookie', async () => {
      await request(server).post('/api/auth/refresh').expect(401);
    });

    it('treats replay of a spent token as theft and kills the lineage', async () => {
      const { body, response } = await register(accountFor('replay'));
      const original = refreshCookie(response);

      const rotated = await request(server)
        .post('/api/auth/refresh')
        .set('Cookie', original)
        .expect(200);
      const successor = refreshCookie(rotated);

      // Push the spent token past the concurrent-tab leeway, so this reads as
      // replay rather than as two tabs racing.
      await prisma.refreshToken.updateMany({
        where: { companyId: body.user.companyId, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 60_000) },
      });

      // The spent token reappearing means two parties hold it.
      await request(server).post('/api/auth/refresh').set('Cookie', original).expect(401);

      // So the token legitimately in play dies with it — that is the point.
      await request(server).post('/api/auth/refresh').set('Cookie', successor).expect(401);
    });

    it('survives two tabs refreshing at once', async () => {
      const { response } = await register(accountFor('tabs'));
      const original = refreshCookie(response);

      const [a, b] = await Promise.all([
        request(server).post('/api/auth/refresh').set('Cookie', original),
        request(server).post('/api/auth/refresh').set('Cookie', original),
      ]);

      // One wins and one is rejected, but the session itself must not be
      // destroyed — restoring several tabs is not an attack.
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);

      const winner = a.status === 200 ? a : b;
      await request(server)
        .post('/api/auth/refresh')
        .set('Cookie', refreshCookie(winner))
        .expect(200);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revokes the refresh token so the session cannot be resumed', async () => {
      const { response } = await register(accountFor('logout'));
      const cookie = refreshCookie(response);

      await request(server).post('/api/auth/logout').set('Cookie', cookie).expect(200);
      await request(server).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('succeeds without a cookie', async () => {
      await request(server).post('/api/auth/logout').expect(200, { ok: true });
    });
  });

  describe('password reset', () => {
    it('answers 200 whether or not the address exists', async () => {
      const account = accountFor('forgot');
      await register(account);

      // Distinguishing the two would let anyone test which emails have accounts.
      await request(server)
        .post('/api/auth/forgot-password')
        .send({ email: account.email })
        .expect(200, { ok: true });

      await request(server)
        .post('/api/auth/forgot-password')
        .send({ email: `nobody.${randomUUID()}@example.test` })
        .expect(200, { ok: true });
    });

    it('retires the previous grant when a new link is requested', async () => {
      const account = accountFor('supersede');
      const { body } = await register(account);

      await request(server).post('/api/auth/forgot-password').send({ email: account.email });
      await request(server).post('/api/auth/forgot-password').send({ email: account.email });

      const live = await prisma.passwordResetToken.findMany({
        where: { userId: body.user.id, usedAt: null },
      });
      expect(live).toHaveLength(1);
    });

    it('rejects an unknown reset token', async () => {
      await request(server)
        .post('/api/auth/reset-password')
        .send({ token: randomUUID(), password: 'a-brand-new-password' })
        .expect(400);
    });
  });

  /**
   * The guard's entire reason for existing. Everything else in this file can be
   * right while this is wrong, and the failure mode is one customer reading
   * another's documents.
   */
  describe('tenant isolation', () => {
    it('hides one company’s rows from another', async () => {
      const alpha = await register(accountFor('alpha'));
      const beta = await register(accountFor('beta'));

      const tenant = app.get(TenantContextService);
      const db = app.get<TenantGuardedClient>(TENANT_PRISMA);

      // Awaited inside run(), the way a request handler runs inside the scope
      // TenantMiddleware opens — Prisma queries do not execute until then.
      const visible = await tenant.run(
        { companyId: alpha.body.user.companyId },
        async () => await db.user.findMany({}),
      );

      expect(visible.map((user) => user.companyId)).toEqual([alpha.body.user.companyId]);

      // Even by primary key: another tenant's row must be indistinguishable
      // from one that does not exist.
      const direct = await tenant.run(
        { companyId: alpha.body.user.companyId },
        async () => await db.user.findUnique({ where: { id: beta.body.user.id } }),
      );

      expect(direct).toBeNull();
    });

    it('fails closed when no company is bound', async () => {
      const db = app.get<TenantGuardedClient>(TENANT_PRISMA);

      // Returning unfiltered rows here is the bug this codebase cannot afford,
      // so the absence of context is an error rather than a wildcard.
      await expect(db.user.findMany({})).rejects.toThrow(/Tenant context missing/);
    });
  });
});
