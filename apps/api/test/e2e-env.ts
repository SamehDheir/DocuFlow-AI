import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Environment for the e2e suite, applied before any module is imported.
 *
 * Each spec file boots its own AppModule. With the worker enabled that means
 * four BullMQ consumers racing for the same queue: they process each other's
 * documents, tests time out waiting for a status that another process already
 * moved, and shutting one app down resets connections the others are using.
 *
 * So the suite runs producer-only. Uploads still enqueue — the tests assert
 * that they do, and that a document lands at PROCESSING — while the pipeline
 * itself is driven directly, and deterministically, by processing.e2e-spec.ts.
 */
process.env.QUEUE_WORKER_ENABLED = 'false';

/**
 * A Redis database of its own, so a DEV SERVER cannot eat the suite's jobs.
 *
 * The flag above only silences the workers inside THIS process. `npm run dev`
 * runs an API with it at its default of `true`, against the same Redis and the
 * same Postgres — so that worker happily consumes jobs these specs enqueue and
 * walks their documents through the pipeline underneath them. The symptom is a
 * status assertion failing against a status nothing in the test set, in
 * whichever specs happen to lose the race, differing run to run. It looks
 * exactly like a regression and is not one.
 *
 * Switching the database index isolates both the queue and the SSE bus: a job
 * published to db 1 is invisible to a consumer subscribed on db 0. The `.env` is
 * read here rather than left to `@nestjs/config`, because by the time that loads
 * the connection has already been built — and dotenv never overwrites a variable
 * that is already set, so this assignment is the one that survives.
 */
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

if (process.env.REDIS_URL) {
  const url = new URL(process.env.REDIS_URL);
  url.pathname = '/1';
  process.env.REDIS_URL = url.toString();
}

/**
 * Never let a test spend real money or depend on a vendor being up. Absent
 * keys select NullAiProvider, but an operator with keys in their .env would
 * otherwise have the suite call out.
 */
process.env.GROQ_API_KEY = '';
process.env.XAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.VOYAGE_API_KEY = '';
