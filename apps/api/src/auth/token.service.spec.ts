import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AuditService } from '../common/audit/audit.service';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import type { Env } from '../config/env.validation';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import type { JwtPayload } from './auth.types';
import { digestToken } from './token-digest';
import { TokenService } from './token.service';

const ENV: Partial<Record<keyof Env, unknown>> = {
  JWT_SECRET: 'access-secret-that-is-at-least-32-chars',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars',
  JWT_REFRESH_EXPIRES_IN: '7d',
  NODE_ENV: 'test',
};

const config = {
  get: (key: keyof Env) => ENV[key],
} as unknown as ConfigService<Env, true>;

interface Row {
  id: string;
  companyId: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * In-memory stand-in for the refresh_tokens table.
 *
 * Rotation and reuse detection are pure record-keeping, so a fake table
 * exercises the real branch logic without needing a database.
 */
function createDb() {
  const rows: Row[] = [];

  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'revokedAt' && value === null) return row.revokedAt === null;
      return row[key as keyof Row] === value;
    });

  const refreshToken = {
    create: ({ data }: { data: Omit<Row, 'id' | 'revokedAt'> }) => {
      const row: Row = { id: randomUUID(), revokedAt: null, ...data };
      rows.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { where: { tokenHash: string } }) =>
      Promise.resolve(rows.find((row) => row.tokenHash === where.tokenHash) ?? null),
    update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      Object.assign(row as Row, data);
      return Promise.resolve(row);
    },
    updateMany: ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return Promise.resolve({ count: hit.length });
    },
  };

  const db = {
    refreshToken,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };

  return { db: db as unknown as TenantGuardedClient, rows };
}

describe('TokenService', () => {
  let rows: Row[];
  let service: TokenService;
  let audit: { record: jest.Mock };

  const subject = { id: 'user-1', companyId: 'company-a', roles: ['Owner'] };

  beforeEach(() => {
    const fake = createDb();
    rows = fake.rows;
    audit = { record: jest.fn().mockResolvedValue(undefined) };

    service = new TokenService(
      new JwtService({}),
      audit as unknown as AuditService,
      new TenantContextService(),
      fake.db,
      config,
    );
  });

  describe('access tokens', () => {
    it('carries the tenant in the payload', async () => {
      const token = await service.signAccessToken(subject);
      const payload = new JwtService({}).verify<JwtPayload>(token, {
        secret: ENV.JWT_SECRET as string,
      });

      // The tenant guard trusts company_id from here and nowhere else.
      expect(payload).toMatchObject({
        sub: 'user-1',
        company_id: 'company-a',
        roles: ['Owner'],
      });
    });
  });

  describe('issueRefreshToken', () => {
    it('persists a keyed digest, never the token itself', async () => {
      const token = await service.issueRefreshToken(subject);

      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).not.toBe(token);
      // A database leak must not hand the attacker usable tokens.
      expect(rows[0].tokenHash).toBe(digestToken(token, ENV.JWT_REFRESH_SECRET as string));
    });

    it('starts a new lineage per login', async () => {
      await service.issueRefreshToken(subject);
      await service.issueRefreshToken(subject);

      expect(rows[0].familyId).not.toBe(rows[1].familyId);
    });

    it('records the device so sessions can be listed later', async () => {
      await service.issueRefreshToken(subject, { ipAddress: '10.0.0.4', userAgent: 'Firefox' });

      expect(rows[0]).toMatchObject({ ipAddress: '10.0.0.4', userAgent: 'Firefox' });
    });
  });

  describe('rotate', () => {
    it('revokes the presented token and issues a successor in the same family', async () => {
      const first = await service.issueRefreshToken(subject);
      const rotated = await service.rotate(first);

      expect(rotated.refreshToken).not.toBe(first);
      expect(rotated).toMatchObject({ userId: 'user-1', companyId: 'company-a' });
      expect(rows[0].revokedAt).toBeInstanceOf(Date);
      expect(rows[1].revokedAt).toBeNull();
      // Same lineage, so a later replay of `first` still implicates this token.
      expect(rows[1].familyId).toBe(rows[0].familyId);
    });

    it('rejects a token that was never issued', async () => {
      await expect(service.rotate('not-a-real-token')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an expired token without revoking the family', async () => {
      const token = await service.issueRefreshToken(subject);
      rows[0].expiresAt = new Date(Date.now() - 1000);

      await expect(service.rotate(token)).rejects.toThrow(UnauthorizedException);
      // Expiry is routine, not an attack — the user simply signs in again.
      expect(audit.record).not.toHaveBeenCalled();
    });

    /** Puts a spent token outside the concurrent-tab leeway. */
    function age(token: string) {
      const row = rows.find(
        (candidate) => candidate.tokenHash === digestToken(token, ENV.JWT_REFRESH_SECRET as string),
      );
      row!.revokedAt = new Date(Date.now() - 60_000);
    }

    it('kills the whole lineage when a rotated token comes back', async () => {
      const first = await service.issueRefreshToken(subject);
      const second = await service.rotate(first);
      const third = await service.rotate(second.refreshToken);
      age(first);

      // `first` was already exchanged. Its reappearance means two parties hold
      // it, and there is no way to tell which one is the legitimate user.
      await expect(service.rotate(first)).rejects.toThrow(UnauthorizedException);

      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      await expect(service.rotate(third.refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('audits the reuse so the incident is visible after the fact', async () => {
      const first = await service.issueRefreshToken(subject);
      await service.rotate(first);
      age(first);

      await expect(service.rotate(first)).rejects.toThrow(UnauthorizedException);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.refresh_reuse_detected',
          companyId: 'company-a',
          userId: 'user-1',
        }),
      );
    });

    it('forgives a token replayed within the leeway, as concurrent tabs do', async () => {
      const first = await service.issueRefreshToken(subject);
      const second = await service.rotate(first);

      // The losing tab of a race: rejected, but the session survives.
      await expect(service.rotate(first)).rejects.toThrow(UnauthorizedException);

      expect(audit.record).not.toHaveBeenCalled();
      await expect(service.rotate(second.refreshToken)).resolves.toMatchObject({
        userId: 'user-1',
      });
    });

    it('spares unrelated sessions on the same account', async () => {
      const phone = await service.issueRefreshToken(subject);
      const laptop = await service.issueRefreshToken(subject);

      await service.rotate(phone);
      await expect(service.rotate(phone)).rejects.toThrow(UnauthorizedException);

      // Signing someone out of every device because one was compromised is
      // right; doing it because a different device merely exists is not.
      const laptopRow = rows.find(
        (row) => row.tokenHash === digestToken(laptop, ENV.JWT_REFRESH_SECRET as string),
      );
      expect(laptopRow?.revokedAt).toBeNull();
    });
  });

  describe('revoke', () => {
    it('returns the session it ended so logout can be audited', async () => {
      const token = await service.issueRefreshToken(subject);

      await expect(service.revoke(token)).resolves.toEqual({
        userId: 'user-1',
        companyId: 'company-a',
      });
      expect(rows[0].revokedAt).toBeInstanceOf(Date);
    });

    it('is idempotent', async () => {
      const token = await service.issueRefreshToken(subject);
      await service.revoke(token);

      // A second logout is not an error worth surfacing to the user.
      await expect(service.revoke(token)).resolves.toBeNull();
    });

    it('reports nothing for a token it never issued', async () => {
      await expect(service.revoke('unknown')).resolves.toBeNull();
    });
  });

  describe('revokeAllForUser', () => {
    it('ends every live session, which is what a password reset needs', async () => {
      await service.issueRefreshToken(subject);
      await service.issueRefreshToken(subject);
      await service.issueRefreshToken({ id: 'user-2', companyId: 'company-a' });

      await service.revokeAllForUser('user-1');

      expect(rows.filter((row) => row.userId === 'user-1').every((row) => row.revokedAt)).toBe(
        true,
      );
      expect(rows.find((row) => row.userId === 'user-2')?.revokedAt).toBeNull();
    });
  });

  describe('cookieOptions', () => {
    it('keeps the refresh cookie off every route but /api/auth', () => {
      const options = service.cookieOptions();

      expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/auth' });
      expect(options.maxAge).toBe(604_800_000);
    });

    it('leaves Secure off outside production so local http development works', () => {
      expect(service.cookieOptions().secure).toBe(false);
    });
  });
});
