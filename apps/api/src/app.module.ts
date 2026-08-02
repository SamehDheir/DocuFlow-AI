import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantMiddleware } from './common/tenant/tenant.middleware';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      /**
       * The environment file lives at the monorepo root — one .env for the whole
       * stack, matching the compose defaults. Paths resolve from process.cwd(),
       * which is apps/api when run through npm workspaces. An app-local .env is
       * listed first so it can override the shared one during debugging.
       */
      envFilePath: ['.env', '../../.env'],
      // Boot fails immediately on invalid configuration rather than surfacing
      // as a confusing runtime error later.
      validate: validateEnv,
    }),
    PrismaModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route so no future controller can be added without
    // tenant context being considered.
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
