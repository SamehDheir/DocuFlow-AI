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
  'Notification',
  'ApprovalRequest',
  'Invitation',
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

/**
 * The three lists above, exposed for `tenant-registration.spec.ts`.
 *
 * That spec parses schema.prisma and fails if a model carrying a `companyId`
 * column appears in none of them — the "keep in sync" comment on
 * TENANT_SCOPED_MODELS was already missed once, and a missing entry means the
 * guard skips the model silently rather than failing closed.
 */
export const TENANT_MODEL_REGISTRY = {
  scoped: TENANT_SCOPED_MODELS,
  transitive: TRANSITIVELY_SCOPED_MODELS,
  root: TENANT_ROOT_MODEL,
} as const;

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
  /** upsert only — the row to insert when `where` matches nothing. */
  create?: Record<string, unknown>;
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
 * (registration, login lookup, platform admin), or `runAs()` to bind a specific
 * company in a queue worker, which has no request to inherit one from.
 *
 * LIMITATION — RAW QUERIES ARE NOT COVERED. This extension hooks
 * `query.$allModels`, which is the model delegate API. `$queryRaw`,
 * `$queryRawUnsafe` and `$executeRaw` bypass it entirely and are NOT filtered:
 * they do not name a model, so there is nothing here to intercept.
 *
 * Full-text search has to be raw — Prisma cannot express tsvector ranking — so
 * every statement in SearchService pins `company_id` by hand from
 * TenantContextService and is covered by a spec that asserts the predicate is
 * present. Any future raw query must do the same. There is no automatic
 * protection at this layer to fall back on.
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

          /**
           * upsert: allowed only when the caller has already pinned the tenant.
           *
           * It cannot be handled like findUnique. That verifies AFTER execution,
           * which is fine for a read — the row is simply withheld — but an
           * upsert WRITES. By the time a post-check noticed the row belonged to
           * someone else, another tenant's data would already be overwritten.
           *
           * It cannot be handled like a create either: `where` must be a unique
           * selector, and Prisma rejects a bare `companyId` added to one.
           *
           * So the tenant has to come from the selector itself — a compound
           * unique such as `@@unique([companyId, name])`, whose where-clause
           * already carries the company. Anything else is refused rather than
           * guessed at: reach the row through its scoped parent as a nested
           * write, or do an explicit findFirst + create/update.
           */
          if (operation === 'upsert') {
            const pinned = findScopeValue(typedArgs.where, scopeField);

            if (pinned === undefined) {
              throw new Error(
                `Unscoped upsert on ${model}. An upsert writes before it can be verified, so ` +
                  `its where-clause must pin the tenant — use a compound unique that includes ` +
                  `${scopeField}, a nested write through the scoped parent, or findFirst + create/update.`,
              );
            }

            if (pinned !== companyId) {
              throw new Error(
                `Cross-tenant upsert on ${model}: where-clause targets a different company.`,
              );
            }

            // Stamp the create half, so the inserted row cannot land in a
            // different company than the one the where-clause selected.
            if (!isRoot && typedArgs.create) {
              typedArgs.create = { ...typedArgs.create, companyId };
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

/**
 * Reads the tenant value out of a unique where-clause.
 *
 * Looks at the top level first (`{ id: … }` on Company), then one level down
 * for Prisma's compound-unique form (`{ companyId_name: { companyId, name } }`).
 * Returns undefined when the clause does not pin the tenant at all.
 */
function findScopeValue(
  where: Record<string, unknown> | undefined,
  scopeField: string,
): string | undefined {
  if (!where) {
    return undefined;
  }

  if (typeof where[scopeField] === 'string') {
    return where[scopeField];
  }

  for (const value of Object.values(where)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = (value as Record<string, unknown>)[scopeField];

      if (typeof nested === 'string') {
        return nested;
      }
    }
  }

  return undefined;
}

/**
 * Declares that a create payload will be tenant-stamped by the guard.
 *
 * `applyTenantGuard` injects `companyId` at runtime, but Prisma's generated
 * input types are static and demand it up front — so every create against a
 * tenant-scoped model would otherwise need a cast. This is the one sanctioned
 * place that assertion lives, which keeps it greppable instead of scattered.
 *
 *   data: tenantCreate({ name, parentId, createdById })
 *
 * Passing companyId yourself still type-checks, and the guard overwrites it —
 * a client-supplied value can never survive.
 */
export function tenantCreate<T extends object>(data: T): T & { companyId: string } {
  return data as T & { companyId: string };
}

export type TenantGuardedClient = ReturnType<typeof applyTenantGuard>;

/**
 * The client handed to a `$transaction` callback: the same delegates, minus the
 * methods that cannot be nested inside a transaction.
 */
export type TenantTransactionClient = Omit<TenantGuardedClient, ITXClientDenyList>;
