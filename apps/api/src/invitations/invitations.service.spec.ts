import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuditService } from '../common/audit/audit.service';
import type { TenantContextService } from '../common/tenant/tenant-context.service';
import type { Env } from '../config/env.validation';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { InvitationsService } from './invitations.service';

const ENV: Partial<Record<keyof Env, unknown>> = {
  JWT_REFRESH_SECRET: 'refresh-secret-that-is-at-least-32-chars',
  CORS_ORIGIN: 'https://app.example.test,https://other.example.test',
  NODE_ENV: 'test',
};

const config = {
  get: (key: keyof Env) => ENV[key],
} as unknown as ConfigService<Env, true>;

const ROLE_ID = randomUUID();
const HOUR = 60 * 60 * 1000;

interface Row {
  id: string;
  companyId: string;
  email: string;
  roleId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  role: { id: string; name: string };
  invitedBy: { firstName: string; lastName: string } | null;
  company: { name: string };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    email: 'ada@example.test',
    roleId: ROLE_ID,
    expiresAt: new Date(Date.now() + 24 * HOUR),
    acceptedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    role: { id: ROLE_ID, name: 'Admin' },
    invitedBy: { firstName: 'Grace', lastName: 'Hopper' },
    company: { name: 'Acme' },
    ...overrides,
  };
}

interface Options {
  existingMember?: boolean;
  roleExists?: boolean;
  found?: Row | null;
  rows?: Row[];
}

function createService({
  existingMember = false,
  roleExists = true,
  found = null,
  rows = [],
}: Options = {}) {
  const created: Record<string, unknown>[] = [];
  const superseded: Record<string, unknown>[] = [];
  const audited: Record<string, unknown>[] = [];

  const tx = {
    invitation: {
      updateMany: (args: Record<string, unknown>) => {
        superseded.push(args);
        return Promise.resolve({ count: 0 });
      },
      create: (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve(row({ ...args.data, role: { id: ROLE_ID, name: 'Admin' } }));
      },
      update: ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(row({ ...(found ?? {}), ...data })),
    },
  };

  const db = {
    user: {
      findFirst: () => Promise.resolve(existingMember ? { id: randomUUID() } : null),
    },
    role: {
      findFirst: () => Promise.resolve(roleExists ? { id: ROLE_ID, name: 'Admin' } : null),
    },
    invitation: {
      findUnique: () => Promise.resolve(found),
      findFirst: () => Promise.resolve(found),
      findMany: () => Promise.resolve(rows),
    },
    $transaction: (fn: (client: typeof tx) => unknown) => Promise.resolve(fn(tx)),
  };

  const audit = {
    record: (entry: Record<string, unknown>) => {
      audited.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;

  const tenant = {
    getUserId: () => randomUUID(),
    // preview() runs on an anonymous request, so it opens a system scope.
    runAsSystem: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as TenantContextService;

  const service = new InvitationsService(
    db as unknown as TenantGuardedClient,
    audit,
    tenant,
    config,
  );

  return { service, created, superseded, audited };
}

describe('InvitationsService.create', () => {
  it('refuses an address that is already a member of this company', async () => {
    const { service } = createService({ existingMember: true });

    await expect(
      service.create({ email: 'ada@example.test', roleId: ROLE_ID }, {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a role from another company — the guard scoped it away', async () => {
    const { service } = createService({ roleExists: false });

    await expect(
      service.create({ email: 'ada@example.test', roleId: randomUUID() }, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores only a digest, never the token itself', async () => {
    const { service, created } = createService();

    const { link } = await service.create({ email: 'ada@example.test', roleId: ROLE_ID }, {});

    const token = new URL(link).searchParams.get('token');
    expect(token).toBeTruthy();
    expect(created[0].tokenHash).not.toBe(token);
    expect(created[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises the address, so casing cannot create a second invitation', async () => {
    const { service, created } = createService();

    await service.create({ email: '  Ada@Example.TEST ', roleId: ROLE_ID }, {});

    expect(created[0].email).toBe('ada@example.test');
  });

  it('supersedes outstanding invitations for the same address', async () => {
    const { service, superseded } = createService();

    await service.create({ email: 'ada@example.test', roleId: ROLE_ID }, {});

    expect(superseded[0]).toMatchObject({
      where: { email: 'ada@example.test', acceptedAt: null, revokedAt: null },
    });
  });

  it('builds the link against the first configured origin', async () => {
    const { service } = createService();

    const { link } = await service.create({ email: 'ada@example.test', roleId: ROLE_ID }, {});

    expect(link.startsWith('https://app.example.test/invite?token=')).toBe(true);
  });

  it('records who was invited and to what', async () => {
    const { service, audited } = createService();

    await service.create({ email: 'ada@example.test', roleId: ROLE_ID }, {});

    expect(audited[0]).toMatchObject({
      action: 'users.invited',
      entityType: 'Invitation',
      metadata: { email: 'ada@example.test', role: 'Admin' },
    });
  });
});

describe('InvitationsService.preview', () => {
  it('answers with the company and role for a live invitation', async () => {
    const { service } = createService({ found: row() });

    await expect(service.preview('token')).resolves.toEqual({
      email: 'ada@example.test',
      companyName: 'Acme',
      roleName: 'Admin',
    });
  });

  it('rejects an unknown token', async () => {
    const { service } = createService({ found: null });

    await expect(service.preview('nope')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an expired invitation', async () => {
    const { service } = createService({ found: row({ expiresAt: new Date(Date.now() - HOUR) }) });

    await expect(service.preview('token')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects one already accepted', async () => {
    const { service } = createService({ found: row({ acceptedAt: new Date() }) });

    await expect(service.preview('token')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects one that was revoked', async () => {
    const { service } = createService({ found: row({ revokedAt: new Date() }) });

    await expect(service.preview('token')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('InvitationsService.resolve', () => {
  it('applies the same validity rule preview does', async () => {
    const expired = createService({ found: row({ expiresAt: new Date(Date.now() - HOUR) }) });
    const revoked = createService({ found: row({ revokedAt: new Date() }) });

    await expect(expired.service.resolve('token')).rejects.toBeInstanceOf(BadRequestException);
    await expect(revoked.service.resolve('token')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns the company from the token, never from the caller', async () => {
    const invitation = row();
    const { service } = createService({ found: invitation });

    await expect(service.resolve('token')).resolves.toMatchObject({
      companyId: invitation.companyId,
      email: invitation.email,
      roleId: invitation.roleId,
    });
  });
});

describe('InvitationsService.list', () => {
  it('derives EXPIRED on read rather than storing it', async () => {
    const { service } = createService({
      rows: [
        row({ expiresAt: new Date(Date.now() - HOUR) }),
        row(),
        row({ acceptedAt: new Date() }),
        row({ revokedAt: new Date() }),
      ],
    });

    const { items } = await service.list();

    expect(items.map((item) => item.status)).toEqual(['EXPIRED', 'PENDING', 'ACCEPTED', 'REVOKED']);
  });

  it('names the inviter, and tolerates one whose account is gone', async () => {
    const { service } = createService({ rows: [row(), row({ invitedBy: null })] });

    const { items } = await service.list();

    expect(items[0].invitedBy).toBe('Grace Hopper');
    expect(items[1].invitedBy).toBeNull();
  });
});
