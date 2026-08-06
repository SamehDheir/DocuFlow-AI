import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

export interface TenantStore {
  companyId: string;
  userId?: string;
  /** Set by runAsSystem() for operations that legitimately span tenants. */
  bypass?: boolean;
}

/**
 * Request-scoped tenant context.
 *
 * Backed by AsyncLocalStorage rather than a NestJS request-scoped provider so
 * that the Prisma extension can read it without the calling code having to
 * thread a companyId through every service signature. Anything that must be
 * passed by hand eventually gets forgotten, and a forgotten companyId in this
 * system means one customer reading another's documents.
 */
@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantStore>();

  /**
   * Run `fn` with tenant context bound. Used by TenantMiddleware per request,
   * where `fn` is `next()` and the whole handler therefore executes inside.
   *
   * Calling this directly with a callback that RETURNS a Prisma query without
   * awaiting it will lose the context — see runAsSystem() for why.
   */
  run<T>(store: TenantStore, fn: () => T): T {
    return this.storage.run(store, fn);
  }

  /**
   * Escape hatch for operations that genuinely have no single tenant:
   * registering a new company, resolving a login before the company is known,
   * platform-wide admin queries, queue workers.
   *
   * Deliberately explicit and named so it stands out in review — this is the
   * one way to bypass tenant filtering.
   *
   * The callback is awaited INSIDE the context rather than merely invoked
   * there. Prisma promises are lazy: they issue no query until something calls
   * `.then()`, so `runAsSystem(() => db.user.findMany())` would hand the
   * unexecuted promise back to a caller who awaits it after this scope has
   * already unwound, and the query would then run with no bypass and fail
   * closed. Awaiting here makes that shape safe rather than a trap.
   */
  async runAsSystem<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.storage.run({ companyId: '', bypass: true }, async () => await fn());
  }

  /**
   * Binds a specific tenant around `fn`. For work that has a company but no
   * request to inherit it from — queue workers, scheduled sweeps.
   *
   * This is NOT a bypass. The guard filters normally; the company simply comes
   * from the job payload instead of from a JWT. That distinction is the whole
   * point: a worker processing one tenant's document must be as constrained as
   * a request would be, and `runAsSystem()` would hand it the entire database.
   *
   * Like runAsSystem(), the callback is awaited INSIDE the scope rather than
   * merely invoked there — a returned-but-unawaited Prisma promise would
   * otherwise execute after the scope unwound, with no tenant bound, and fail
   * closed. `run()` cannot do this because TenantMiddleware passes it a
   * synchronous next().
   */
  async runAs<T>(
    companyId: string,
    userId: string | undefined,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    if (!companyId) {
      throw new Error(
        'runAs() requires a companyId. Use runAsSystem() for genuinely cross-tenant work.',
      );
    }

    return this.storage.run({ companyId, userId }, async () => await fn());
  }

  getStore(): TenantStore | undefined {
    return this.storage.getStore();
  }

  isBypassed(): boolean {
    return this.storage.getStore()?.bypass === true;
  }

  /** Current company, or undefined when there is no context. */
  getCompanyId(): string | undefined {
    const store = this.storage.getStore();
    return store?.bypass ? undefined : store?.companyId;
  }

  getUserId(): string | undefined {
    return this.storage.getStore()?.userId;
  }
}
