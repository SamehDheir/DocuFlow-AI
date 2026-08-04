import { PrismaClient } from '@prisma/client';
import type { ITXClientDenyList } from '@prisma/client/runtime/client';
import { TenantContextService } from '../common/tenant/tenant-context.service';

/**
 * Models that carry a `companyId` column and are therefore filtered
 * automatically. Keep in sync with prisma/schema.prisma.
 */
const TENANT_SCOPED_MODELS = new Set([
  'User',
  'Role',
  'Folder',
  'Document',
  'Tag',
  'AuditLog',
  'RefreshToken',
  'PasswordResetToken',
]);

/**
 * Company is the tenant itself: its primary key IS the companyId, so it is
 * scoped on `id` rather than on a `companyId` column.
 */
const TENANT_ROOT_MODEL = 'Company';

/**
 * Join/child models with no `companyId` of their own. They are reachable only
 * through a scoped parent, so isolation is transitive rather than enforced here.
 *
 * LIMITATION: querying these directly (e.g. `prisma.documentVersion.findMany()`
 * with a raw documentId) bypasses tenant filtering entirely. Always reach them
 * via their parent, or verify the parent's companyId first.
 */
const TRANSITIVELY_SCOPED_MODELS = new Set([
  'DocumentVersion',
  'DocumentMetadata',
  'DocumentTag',
  'RolePermission',
  'UserRole',
]);

/** Operations whose payload lives in `args.data`. */
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

/**
 * Operations taking a unique `where`. Prisma rejects arbitrary non-unique
 * filters here, so these are verified AFTER execution instead of filtered
 * before it.
 */
const UNIQUE_READ_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow']);

type QueryArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  [key: string]: unknown;
};

/**
 * Applies automatic `companyId` filtering to every Prisma query.
 *
 * Fail-closed by design: with no tenant context bound, a query against a
 * tenant-scoped model THROWS rather than returning unfiltered rows. The failure
 * mode of the opposite choice is silent cross-tenant data disclosure, which is
 * exactly the bug class this system cannot afford.
 *
 * Use `TenantContextService.runAsSystem()` for the legitimate exceptions
 * (registration, login lookup, platform admin, queue workers).
 */
export function applyTenantGuard(client: PrismaClient, tenant: TenantContextService) {
  return client.$extends({
    name: 'tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const isScoped = TENANT_SCOPED_MODELS.has(model);
          const isRoot = model === TENANT_ROOT_MODEL;

          if ((!isScoped && !isRoot) || TRANSITIVELY_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          if (tenant.isBypassed()) {
            return query(args);
          }

          const companyId = tenant.getCompanyId();

          if (!companyId) {
            throw new Error(
              `Tenant context missing for ${model}.${operation}. ` +
                `Every query against a tenant-scoped model must run inside TenantContextService.run(), ` +
                `or explicitly inside runAsSystem() when the operation genuinely spans tenants.`,
            );
          }

          const scopeField = isRoot ? 'id' : 'companyId';
          const typedArgs = (args ?? {}) as QueryArgs;

          // Creates: stamp the tenant onto the payload so callers cannot write
          // a row into someone else's company, by mistake or otherwise.
          if (CREATE_OPERATIONS.has(operation)) {
            if (isRoot) {
              return query(args);
            }

            if (Array.isArray(typedArgs.data)) {
              typedArgs.data = typedArgs.data.map((row) => ({ ...row, companyId }));
            } else if (typedArgs.data) {
              typedArgs.data = { ...typedArgs.data, companyId };
            }

            return query(typedArgs);
          }

          // findUnique/findUniqueOrThrow: `where` only accepts unique fields, so
          // the row is fetched and then checked. Returning null on a mismatch
          // makes another tenant's record indistinguishable from a missing one,
          // which avoids leaking existence.
          if (UNIQUE_READ_OPERATIONS.has(operation)) {
            const result = (await query(args)) as Record<string, unknown> | null;

            if (result && result[scopeField] !== companyId) {
              if (operation === 'findUniqueOrThrow') {
                throw new Error(`No ${model} found`);
              }
              return null;
            }

            return result;
          }

          // Everything else (findMany, findFirst, update, delete, count,
          // aggregate, …) accepts arbitrary filters, so scope up front.
          typedArgs.where = { ...(typedArgs.where ?? {}), [scopeField]: companyId };

          return query(typedArgs);
        },
      },
    },
  });
}

export type TenantGuardedClient = ReturnType<typeof applyTenantGuard>;

/**
 * The client handed to a `$transaction` callback: the same delegates, minus the
 * methods that cannot be nested inside a transaction.
 */
export type TenantTransactionClient = Omit<TenantGuardedClient, ITXClientDenyList>;
