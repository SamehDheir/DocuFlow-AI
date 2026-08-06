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
 * Never let a test spend real money or depend on a vendor being up. Absent
 * keys select NullAiProvider, but an operator with keys in their .env would
 * otherwise have the suite call out.
 */
process.env.GROQ_API_KEY = '';
process.env.XAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.VOYAGE_API_KEY = '';
