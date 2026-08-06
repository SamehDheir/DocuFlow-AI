import { PrismaClient } from '@prisma/client';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { applyTenantGuard } from './tenant-guard';

/**
 * Records the args the extension forwards, so each test can assert on what the
 * guard did to a query rather than on what a database returned.
 *
 * `$extends` is real here — only the underlying query function is faked, which
 * is the part that would otherwise need a live Postgres.
 */
function createClient(result: unknown = null) {
  const calls: { model: string; operation: string; args: Record<string, unknown> }[] = [];

  const base = {
    $extends(extension: {
      query: {
        $allModels: {
          $allOperations: (params: {
            model: string;
            operation: string;
            args: Record<string, unknown>;
            query: (args: Record<string, unknown>) => Promise<unknown>;
          }) => Promise<unknown>;
        };
      };
    }) {
      const run = extension.query.$allModels.$allOperations;

      return {
        call(model: string, operation: string, args: Record<string, unknown> = {}) {
          return run({
            model,
            operation,
            args,
            query: (forwarded) => {
              calls.push({ model, operation, args: forwarded });
              return Promise.resolve(result);
            },
          });
        },
      };
    },
  } as unknown as PrismaClient;

  return { base, calls };
}

const COMPANY = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function guarded(result?: unknown) {
  const tenant = new TenantContextService();
  const { base, calls } = createClient(result);
  const client = applyTenantGuard(base, tenant) as unknown as {
    call(model: string, operation: string, args?: Record<string, unknown>): Promise<unknown>;
  };

  return { tenant, client, calls };
}

describe('applyTenantGuard', () => {
  describe('upsert', () => {
    it('refuses an upsert whose where-clause does not pin the tenant', async () => {
      const { tenant, client } = guarded();

      await expect(
        tenant.run({ companyId: COMPANY }, () =>
          client.call('Tag', 'upsert', { where: { id: 'tag-1' }, create: {}, update: {} }),
        ),
      ).rejects.toThrow(/Unscoped upsert on Tag/);
    });

    it('refuses an upsert aimed at another company', async () => {
      const { tenant, client } = guarded();

      await expect(
        tenant.run({ companyId: COMPANY }, () =>
          client.call('Tag', 'upsert', {
            where: { companyId_name: { companyId: OTHER, name: 'invoices' } },
            create: { name: 'invoices' },
            update: {},
          }),
        ),
      ).rejects.toThrow(/Cross-tenant upsert on Tag/);
    });

    it('allows a compound-unique upsert and stamps the create half', async () => {
      const { tenant, client, calls } = guarded();

      await tenant.run({ companyId: COMPANY }, () =>
        client.call('Tag', 'upsert', {
          where: { companyId_name: { companyId: COMPANY, name: 'invoices' } },
          create: { name: 'invoices' },
          update: { color: '#fff' },
        }),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].args.create).toEqual({ name: 'invoices', companyId: COMPANY });
      // The where-clause must survive untouched — Prisma rejects a bare
      // companyId added alongside a compound unique selector.
      expect(calls[0].args.where).toEqual({
        companyId_name: { companyId: COMPANY, name: 'invoices' },
      });
    });

    it('leaves untenanted models alone', async () => {
      const { tenant, client, calls } = guarded();

      await tenant.run({ companyId: COMPANY }, () =>
        client.call('Permission', 'upsert', {
          where: { name: 'documents.read' },
          create: { name: 'documents.read', module: 'documents' },
          update: {},
        }),
      );

      expect(calls[0].args.create).toEqual({ name: 'documents.read', module: 'documents' });
    });
  });

  describe('existing behaviour still holds', () => {
    it('stamps companyId onto a create', async () => {
      const { tenant, client, calls } = guarded();

      await tenant.run({ companyId: COMPANY }, () =>
        client.call('Folder', 'create', { data: { name: 'Contracts' } }),
      );

      expect(calls[0].args.data).toEqual({ name: 'Contracts', companyId: COMPANY });
    });

    it('scopes a findMany before execution', async () => {
      const { tenant, client, calls } = guarded([]);

      await tenant.run({ companyId: COMPANY }, () =>
        client.call('Document', 'findMany', { where: { deletedAt: null } }),
      );

      expect(calls[0].args.where).toEqual({ deletedAt: null, companyId: COMPANY });
    });

    it('withholds another company row from findUnique', async () => {
      const { tenant, client } = guarded({ id: 'doc-1', companyId: OTHER });

      const found = await tenant.run({ companyId: COMPANY }, () =>
        client.call('Document', 'findUnique', { where: { id: 'doc-1' } }),
      );

      expect(found).toBeNull();
    });

    it('fails closed with no tenant bound', async () => {
      const { client } = guarded();

      await expect(client.call('Document', 'findMany')).rejects.toThrow(/Tenant context missing/);
    });
  });
});
