import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env.validation';

/**
 * Raw, UNGUARDED Prisma client.
 *
 * Injecting this bypasses tenant filtering completely. It exists for
 * infrastructure concerns only — connection lifecycle and health probes.
 * Application code should inject TENANT_PRISMA instead.
 *
 * Prisma 7 requires a driver adapter for direct database connections; the
 * connection string no longer comes from schema.prisma.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
