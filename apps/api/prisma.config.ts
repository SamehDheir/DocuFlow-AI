import path from 'node:path';
import { defineConfig } from '@prisma/config';
import dotenv from 'dotenv';

/**
 * Prisma CLI configuration (generate, migrate, studio).
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

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),

  /**
   * Only declare the datasource when a URL is actually available.
   *
   * `prisma generate` runs during the Docker image build (docker/api.Dockerfile),
   * where there is no .env and no DATABASE_URL. The previous `env('DATABASE_URL')`
   * call resolved eagerly at module load and threw PrismaConfigEnvError there,
   * failing the image build even though generate never needs a live connection.
   *
   * Commands that genuinely require a database — migrate, studio, db pull —
   * still fail loudly with Prisma's own "datasource not configured" error, so
   * this does not paper over a missing URL where one is needed.
   */
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),

  migrations: {
    path: path.join('prisma', 'migrations'),
  },
});
