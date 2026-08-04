import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  let service: TenantContextService;

  beforeEach(() => {
    service = new TenantContextService();
  });

  it('reports no company outside any context', () => {
    expect(service.getCompanyId()).toBeUndefined();
    expect(service.getStore()).toBeUndefined();
    expect(service.isBypassed()).toBe(false);
  });

  it('binds the company for the duration of run()', () => {
    service.run({ companyId: 'company-a', userId: 'user-1' }, () => {
      expect(service.getCompanyId()).toBe('company-a');
      expect(service.getUserId()).toBe('user-1');
    });

    // Context must not survive past the callback.
    expect(service.getCompanyId()).toBeUndefined();
  });

  it('keeps context bound across await boundaries', async () => {
    await service.run({ companyId: 'company-a' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(service.getCompanyId()).toBe('company-a');
    });
  });

  it('does not leak context between concurrent requests', async () => {
    // The failure this guards against: two in-flight requests sharing state, so
    // one tenant's query executes with another tenant's company id.
    const seen: string[] = [];

    const requestA = service.run({ companyId: 'company-a' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen.push(service.getCompanyId() ?? 'none');
    });

    const requestB = service.run({ companyId: 'company-b' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(service.getCompanyId() ?? 'none');
    });

    await Promise.all([requestA, requestB]);

    // B finishes first despite starting second; each must still see its own tenant.
    expect(seen).toEqual(['company-b', 'company-a']);
  });

  it('reports bypass and withholds a company id under runAsSystem()', async () => {
    await service.runAsSystem(() => {
      expect(service.isBypassed()).toBe(true);
      // Must not surface a usable company id — callers should never silently
      // scope to the empty-string tenant.
      expect(service.getCompanyId()).toBeUndefined();
    });

    expect(service.isBypassed()).toBe(false);
  });

  it('keeps bypass bound while a lazily-executed callback settles', async () => {
    // Prisma promises issue no query until awaited. A callback that returns one
    // unawaited must still resolve inside the bypass, or the query lands
    // outside it and fails closed — which is how login and refresh break.
    const deferred = await service.runAsSystem(() =>
      Promise.resolve().then(() => service.isBypassed()),
    );

    expect(deferred).toBe(true);
  });

  it('allows an inner context to override an outer one', () => {
    service.run({ companyId: 'company-a' }, () => {
      service.run({ companyId: 'company-b' }, () => {
        expect(service.getCompanyId()).toBe('company-b');
      });

      expect(service.getCompanyId()).toBe('company-a');
    });
  });
});
