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

  /** Run `fn` with tenant context bound. Used by TenantMiddleware per request. */
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
   */
  runAsSystem<T>(fn: () => T): T {
    return this.storage.run({ companyId: '', bypass: true }, fn);
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
