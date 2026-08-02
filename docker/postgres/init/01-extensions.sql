-- Extensions required by DocuFlow AI.
--
-- Runs ONCE, during first initialisation of an empty postgres-data volume.
-- Editing this file does NOT affect an already-initialised database — run
-- `npm run infra:reset` to recreate the volume, or apply the statements by hand.
--
-- Prisma does not create extensions on its own, so these must exist before the
-- first migration that depends on them.

-- Vector similarity search for the AI module (document embeddings).
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram indexes: powers fuzzy / partial filename and content matching.
-- Needed for "smart search" to tolerate typos rather than only exact matches.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accent-insensitive search. Document titles and OCR output are multilingual
-- (Arabic and English), so search must match regardless of diacritics.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Cryptographic helpers (digest/hmac) for document hashing and token handling.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
