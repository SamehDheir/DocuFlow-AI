import { Global, Module } from '@nestjs/common';
import { TenantContextService } from '../common/tenant/tenant-context.service';
import { PrismaService } from './prisma.service';
import { applyTenantGuard, type TenantGuardedClient } from './tenant-guard';

/**
 * Injection token for the tenant-filtered client.
 *
 *   constructor(@Inject(TENANT_PRISMA) private readonly db: TenantGuardedClient) {}
 *
 * This is the client application code should use. PrismaService is the raw,
 * unfiltered one and is reserved for infrastructure.
 */
export const TENANT_PRISMA = Symbol('TENANT_PRISMA');

@Global()
@Module({
  providers: [
    TenantContextService,
    PrismaService,
    {
      provide: TENANT_PRISMA,
      inject: [PrismaService, TenantContextService],
      useFactory: (prisma: PrismaService, tenant: TenantContextService): TenantGuardedClient =>
        applyTenantGuard(prisma, tenant),
    },
  ],
  exports: [TenantContextService, PrismaService, TENANT_PRISMA],
})
export class PrismaModule {}
