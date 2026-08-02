import { z } from 'zod';

/**
 * Environment validation.
 *
 * Runs once at boot and fails hard. A missing DATABASE_URL should stop the
 * process immediately with a readable message, not surface later as an opaque
 * connection error on the first request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Object storage
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(1).default('docuflow-documents'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(20).default(12),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  MAX_FILE_SIZE: z.coerce.number().int().positive().default(104857600),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  /**
   * The access and refresh secrets must differ. If they match, an access token
   * validates as a refresh token, so a leaked short-lived token can be traded
   * for indefinite session renewal. Cheap to check, easy to get wrong by
   * copy-pasting .env values.
   */
  if (parsed.data.JWT_SECRET === parsed.data.JWT_REFRESH_SECRET) {
    throw new Error(
      'Invalid environment configuration:\n  - JWT_SECRET and JWT_REFRESH_SECRET must be different values',
    );
  }

  return parsed.data;
}
