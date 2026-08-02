import path from 'node:path';
import { defineConfig, env } from '@prisma/config';
import dotenv from 'dotenv';

/**
 * Prisma CLI configuration (migrate, studio, db).
 *
 * Prisma 7 removed `url` from the datasource block in schema.prisma and no
 * longer loads .env automatically, so both are wired up here.
 *
 * The environment file lives at the MONOREPO ROOT, not in apps/api — one .env
 * serves the whole stack and matches the compose defaults. An app-local .env
 * is loaded afterwards if present, for per-app overrides.
 */
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env'), override: true });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
});
