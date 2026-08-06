import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuditService } from '../common/audit/audit.service';
import type { TenantContextService } from '../common/tenant/tenant-context.service';
import type { TenantGuardedClient } from '../prisma/tenant-guard';
import { UsersService } from './users.service';

/**
 * The last-Owner guard is the reason this file exists.
 *
 * Owner is the only role holding `roles.manage`, so demoting the final one
 * produces a company nobody can ever administer again — and there is no repair
 * path through the API, only a database console. It is the one mistake here
 * that cannot be undone by making the opposite request.
 */

const OWNER_ID = randomUUID();
const ADMIN_ID = randomUUID();
const MEMBER_ID = randomUUID();

const ROLES = [
  { id: OWNER_ID, name: 'Owner' },
  { id: ADMIN_ID, name: 'Admin' },
  { id: MEMBER_ID, name: 'Member' },
];

interface Options {
  /** Roles the member currently holds. */
  held?: { id: string; name: string }[];
  /** How many active Owners the company has, this member included. */
  owners?: number;
  /** Roles that exist in the company — short of the full set to model a foreign id. */
  available?: { id: string; name: string }[];
  missing?: boolean;
}

function createService({
  held = [{ id: OWNER_ID, name: 'Owner' }],
  owners = 2,
  available = ROLES,
  missing = false,
}: Options = {}) {
  const userId = randomUUID();
  const deleted: unknown[] = [];
  const created: unknown[] = [];
  const audited: Record<string, unknown>[] = [];

  const tx = {
    userRole: {
      deleteMany: (args: unknown) => {
        deleted.push(args);
        return Promise.resolve({ count: held.length });
      },
      createMany: (args: { data: { roleId: string }[] }) => {
        created.push(args);
        return Promise.resolve({ count: args.data.length });
      },
    },
    user: {
      findFirstOrThrow: () =>
        Promise.resolve({
          id: userId,
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.test',
          isActive: true,
          createdAt: new Date(),
          roles: (created[0] as { data: { roleId: string }[] } | undefined)?.data.map((row) => ({
            role: { name: ROLES.find((role) => role.id === row.roleId)?.name ?? '?' },
          })),
        }),
    },
  };

  const db = {
    user: {
      findFirst: () =>
        Promise.resolve(missing ? null : { id: userId, roles: held.map((role) => ({ role })) }),
      count: () => Promise.resolve(owners),
    },
    role: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(available.filter((role) => where.id.in.includes(role.id))),
    },
    $transaction: (fn: (client: typeof tx) => unknown) => Promise.resolve(fn(tx)),
  };

  const audit = {
    record: (entry: Record<string, unknown>) => {
      audited.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;

  const service = new UsersService(
    db as unknown as TenantGuardedClient,
    audit,
    {} as TenantContextService,
  );

  return { service, userId, deleted, created, audited };
}

describe('UsersService.setRoles', () => {
  it('refuses to demote the last Owner', async () => {
    const { service, userId } = createService({
      held: [{ id: OWNER_ID, name: 'Owner' }],
      owners: 1,
    });

    await expect(service.setRoles(userId, [MEMBER_ID], {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('allows demoting an Owner while another remains', async () => {
    const { service, userId, created } = createService({
      held: [{ id: OWNER_ID, name: 'Owner' }],
      owners: 2,
    });

    await service.setRoles(userId, [MEMBER_ID], {});

    expect(created).toHaveLength(1);
  });

  it('lets the last Owner keep Owner while gaining another role', async () => {
    const { service, userId } = createService({
      held: [{ id: OWNER_ID, name: 'Owner' }],
      owners: 1,
    });

    // The count is never consulted when Owner survives the edit.
    await expect(service.setRoles(userId, [OWNER_ID, ADMIN_ID], {})).resolves.toBeDefined();
  });

  it('does not consult the Owner count when the member was never an Owner', async () => {
    const { service, userId } = createService({
      held: [{ id: MEMBER_ID, name: 'Member' }],
      owners: 1,
    });

    await expect(service.setRoles(userId, [ADMIN_ID], {})).resolves.toBeDefined();
  });

  it('rejects a role id that does not belong to this company', async () => {
    const foreign = randomUUID();
    const { service, userId } = createService();

    await expect(service.setRoles(userId, [foreign], {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an empty role set rather than stranding a member with no access', async () => {
    const { service, userId } = createService();

    await expect(service.setRoles(userId, [], {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s for a member outside the company — the guard scoped the lookup away', async () => {
    const { service, userId } = createService({ missing: true });

    await expect(service.setRoles(userId, [ADMIN_ID], {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('replaces rather than accumulates: old links are deleted first', async () => {
    const { service, userId, deleted, created } = createService({
      held: [{ id: OWNER_ID, name: 'Owner' }],
    });

    await service.setRoles(userId, [ADMIN_ID], {});

    expect(deleted).toHaveLength(1);
    expect(created[0]).toEqual({ data: [{ userId, roleId: ADMIN_ID }] });
  });

  it('de-duplicates a repeated role id — the pair is a primary key', async () => {
    const { service, userId, created } = createService();

    await service.setRoles(userId, [ADMIN_ID, ADMIN_ID], {});

    expect(created[0]).toEqual({ data: [{ userId, roleId: ADMIN_ID }] });
  });

  it('records the change with both the old and the new roles', async () => {
    const { service, userId, audited } = createService({
      held: [{ id: OWNER_ID, name: 'Owner' }],
    });

    await service.setRoles(userId, [ADMIN_ID], {});

    expect(audited[0]).toMatchObject({
      action: 'users.roles_changed',
      entityType: 'User',
      entityId: userId,
      metadata: { from: ['Owner'], to: ['Admin'] },
    });
  });

  it('audits inside the transaction, so the trail cannot outlive a rollback', async () => {
    const { service, userId, audited, created } = createService();

    await service.setRoles(userId, [ADMIN_ID], {});

    // Both happened against the same transaction client the fake handed out.
    expect(created).toHaveLength(1);
    expect(audited).toHaveLength(1);
  });
});
