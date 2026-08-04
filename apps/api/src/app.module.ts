import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtMiddleware } from './auth/jwt.middleware';
import { MulterExceptionFilter } from './common/errors/multer-exception.filter';
import { PrismaExceptionFilter } from './common/errors/prisma-exception.filter';
import { TenantMiddleware } from './common/tenant/tenant.middleware';
import { validateEnv } from './config/env.validation';
import { DocumentsModule } from './documents/documents.module';
import { FoldersModule } from './folders/folders.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';

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
    AuthModule,
    HealthModule,
    StorageModule,
    FoldersModule,
    DocumentsModule,
  ],
  providers: [
    /**
     * Constraint violations are client mistakes, not server failures. Without
     * this a duplicate folder name would surface as a 500 with a stack trace.
     */
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
    /** Likewise an over-limit upload, which is a 413 rather than a crash. */
    { provide: APP_FILTER, useClass: MulterExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    /**
     * Order is execution order, and it matters: JwtMiddleware resolves the
     * principal that TenantMiddleware reads to bind the company. Reversed, no
     * request would ever carry tenant context and every tenant-scoped query
     * would fail closed.
     *
     * Applied to every route so no future controller can be added without
     * tenant context being considered.
     */
    consumer.apply(JwtMiddleware, TenantMiddleware).forRoutes('*');
  }
}
