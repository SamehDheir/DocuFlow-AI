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

  // Uploads
  MAX_FILE_SIZE: z.coerce.number().int().positive().default(104857600),
  /**
   * Comma-separated allowlist, parsed once at boot.
   *
   * An allowlist rather than a blocklist: the set of dangerous types is open
   * ended, the set this product accepts is not. Must stay at or below nginx's
   * `client_max_body_size` in docker/nginx/nginx.conf, currently 100m.
   */
  ALLOWED_MIME_TYPES: z
    .string()
    .default(
      'application/pdf,image/png,image/jpeg,image/tiff,application/msword,' +
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
        'application/vnd.ms-excel,' +
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
        // PowerPoint, .ppt and .pptx. Word and Excel were both here from the
        // start and presentations were simply missed — an office suite minus
        // one third of it.
        'application/vnd.ms-powerpoint,' +
        'application/vnd.openxmlformats-officedocument.presentationml.presentation,' +
        'text/plain',
    )
    .transform((value) =>
      value
        .split(',')
        .map((type) => type.trim().toLowerCase())
        .filter(Boolean),
    ),

  /**
   * AI provider.
   *
   * Every key is optional and the whole block may be absent: with no key
   * configured the AI module falls back to NullAiProvider, which returns
   * deterministic stub output. Processing still runs end to end, every UI state
   * is still reachable, and CI does not need a credential.
   *
   * `xai` is the default provider. It speaks the OpenAI wire format at
   * XAI_BASE_URL, so no vendor SDK is required — plain fetch is enough.
   */
  AI_PROVIDER: z.enum(['groq', 'xai', 'anthropic', 'openai']).optional(),

  /**
   * Groq — LPU inference over open models. Note the spelling: this is NOT xAI's
   * Grok, which is the block below.
   *
   * Two models, because Groq's text models reject image content outright and
   * only the Qwen multimodal model accepts it. Blank GROQ_VISION_MODEL disables
   * OCR while leaving summaries working.
   */
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_VISION_MODEL: z.string().default('qwen/qwen3.6-27b'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),

  /** xAI (Grok) — one model handles both text and vision. */
  XAI_API_KEY: z.string().optional(),
  XAI_MODEL: z.string().default('grok-4.5'),
  XAI_BASE_URL: z.string().url().default('https://api.x.ai/v1'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  /**
   * Embeddings are a dormant seam.
   *
   * xAI exposes no public embeddings endpoint, so semantic search cannot run on
   * the same key as OCR and summarisation. `document_metadata.embedding` is
   * created at vector(1024) — Voyage's width — and stays NULL until one of
   * these keys appears. Search runs on Postgres full text until then, so
   * switching semantic search on later needs no migration.
   *
   * Note the width: OpenAI's text-embedding-3-small is 1536 and will NOT fit
   * that column. Pair OPENAI_API_KEY with a model reduced to 1024 dimensions.
   */
  VOYAGE_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('voyage-3'),

  /**
   * Processing limits.
   *
   * A scanned page costs one vision call, so an unbounded page count turns a
   * single 400-page upload into a surprise invoice. Text-layer extraction is
   * free and is always tried first — this cap only ever applies to true scans.
   */
  AI_OCR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Default 8, sized for a free tier rather than a paid one.
   *
   * Measured on Groq's free plan: 8,000 tokens per minute against roughly
   * 1,200-3,000 tokens for one page image — a handful of pages before the limit
   * bites. A higher cap does not read more pages, it just spends longer being
   * rate limited. Raise it when the plan allows.
   */
  AI_MAX_OCR_PAGES: z.coerce.number().int().positive().default(8),
  /** Hard ceiling on one provider call, so a hung request cannot pin a worker. */
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  /** Characters of extracted text sent to the summariser. */
  AI_MAX_SUMMARY_CHARS: z.coerce.number().int().positive().default(60000),
  /** Concurrent documents processed per API instance. */
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /**
   * Whether this process consumes the queue as well as producing to it.
   *
   * On by default: one container runs both halves, which is the right shape for
   * this deployment. Turning it off is what lets the API scale separately from
   * the workers later — and it is what the e2e suite does, because each spec
   * file boots its own AppModule and four workers racing for the same jobs
   * would process each other's documents.
   */
  QUEUE_WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

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
