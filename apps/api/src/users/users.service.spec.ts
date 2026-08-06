import { randomUUID } from 'node:crypto';
import type { AuditService } from '../common/audit/audit.service';
import type { TenantContextService } from '../common/tenant/tenant-context.service';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { UsersService } from './users.service';

interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  isActive: boolean;
  createdAt: Date;
  roles: { role: { name: string } }[];
}

function member(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: randomUUID(),
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
    isActive: true,
    createdAt: new Date(),
    roles: [{ role: { name: 'Owner' } }],
    ...overrides,
  };
}

function createDb(rows: UserRow[]) {
  const calls: Record<string, unknown>[] = [];

  const db = {
    user: {
      findMany: (args: Record<string, unknown>) => {
        calls.push(args);
        return Promise.resolve(rows);
      },
    },
  };

  return { db: db as unknown as TenantGuardedClient, calls };
}

/**
 * The list path touches neither the audit trail nor the tenant context, so
 * these are stubs rather than fakes. `setRoles` has its own suite below with
 * real recording assertions.
 */
const audit = { record: jest.fn() } as unknown as AuditService;
const tenant = {} as TenantContextService;

function service(db: TenantGuardedClient): UsersService {
  return new UsersService(db, audit, tenant);
}

describe('UsersService', () => {
  it('flattens the role join into plain names', async () => {
    const { db } = createDb([
      member({ roles: [{ role: { name: 'Owner' } }, { role: { name: 'Member' } }] }),
    ]);

    const { items } = await service(db).list();

    expect(items[0].roles).toEqual(['Owner', 'Member']);
  });

  it('never selects the password hash', async () => {
    const { db, calls } = createDb([member()]);
    await service(db).list();

    expect(calls[0].select).not.toHaveProperty('passwordHash');
    // An explicit select, not an include — a new column must not appear by default.
    expect(calls[0]).not.toHaveProperty('include');
  });

  it('reaches roles through User rather than querying UserRole', async () => {
    const { db, calls } = createDb([member()]);
    await service(db).list();

    expect(calls[0].select).toHaveProperty('roles');
  });

  it('never filters by companyId — the tenant guard injects it', async () => {
    const { db, calls } = createDb([member()]);
    await service(db).list();

    expect(calls[0].where).toBeUndefined();
  });

  it('orders active members before deactivated ones', async () => {
    const { db, calls } = createDb([member()]);
    await service(db).list();

    expect(calls[0].orderBy).toEqual([
      { isActive: 'desc' },
      { firstName: 'asc' },
      { lastName: 'asc' },
    ]);
  });

  it('reports the total alongside the list', async () => {
    const { db } = createDb([member(), member(), member()]);

    const result = await service(db).list();

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
  });

  it('counts deactivated members too — they still occupy a seat', async () => {
    const { db } = createDb([member(), member({ isActive: false })]);

    const { total, items } = await service(db).list();

    expect(total).toBe(2);
    expect(items.some((row) => !row.isActive)).toBe(true);
  });
});
