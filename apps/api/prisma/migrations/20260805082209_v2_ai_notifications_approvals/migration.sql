-- ---------------------------------------------------------------------------
-- Extensions this migration depends on.
--
-- docker/postgres/init/01-extensions.sql already creates these, but that script
-- runs ONCE, on first volume initialisation, and only for the compose database.
-- Two places therefore lack them: the shadow database `prisma migrate dev`
-- spins up to validate this file, and any production database not provisioned
-- by that compose file. Both would fail on `vector` below.
--
-- A migration must carry its own prerequisites. IF NOT EXISTS keeps it a no-op
-- where the init script already ran.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- CreateEnum
CREATE TYPE "ProcessingStage" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DOCUMENT_READY', 'DOCUMENT_FAILED', 'APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'APPROVAL_REJECTED', 'APPROVAL_CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "document_metadata" ADD COLUMN     "ai_completed_at" TIMESTAMP(3),
ADD COLUMN     "ai_error" TEXT,
ADD COLUMN     "ai_model" TEXT,
ADD COLUMN     "ai_status" "ProcessingStage" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "embedding" vector(1024),
ADD COLUMN     "extracted_text" TEXT,
ADD COLUMN     "ocr_completed_at" TIMESTAMP(3),
ADD COLUMN     "ocr_error" TEXT,
ADD COLUMN     "ocr_pages" INTEGER,
ADD COLUMN     "ocr_status" "ProcessingStage" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "search_vector" tsvector,
ADD COLUMN     "summary" TEXT;

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "actor_id" UUID,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "payload" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "assignee_id" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "decision_note" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_company_id_user_id_read_at_created_at_idx" ON "notifications"("company_id", "user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_company_id_status_created_at_idx" ON "approval_requests"("company_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "approval_requests_company_id_document_id_idx" ON "approval_requests"("company_id", "document_id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Everything below is hand-written. Prisma cannot express any of it: triggers,
-- expression indexes, and partial unique indexes have no schema.prisma syntax.
-- Regenerating this migration would drop it, so it must be re-applied by hand
-- if that ever happens.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- An IMMUTABLE unaccent, so it can be used in an index and a trigger.
--
-- The stock one-argument unaccent() is only STABLE: it resolves its dictionary
-- through search_path, so the same input can give different output. Postgres
-- therefore refuses it in an index expression. Pinning the dictionary with the
-- two-argument form removes that dependency and makes the wrapper genuinely
-- immutable. This is the standard recipe, not a workaround.
--
-- It matters for Arabic: unaccent strips tashkeel, so a word written with
-- diacritics still matches the same word written without them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION f_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, $1)
$$;

-- ---------------------------------------------------------------------------
-- search_vector maintenance.
--
-- A trigger rather than a GENERATED column. A generated column's expression
-- must be immutable at DDL time, and while f_unaccent() above qualifies, the
-- whole expression would then be frozen into the table definition — changing
-- how documents are indexed would mean rewriting the column. A trigger can be
-- replaced with CREATE OR REPLACE and a reindex.
--
-- Weights rank a hit by where it landed: a title match should beat a passing
-- mention buried in page 40 of a scan. ts_rank_cd honours these by default.
--   A title · B keywords · C description + summary · D extracted body text
--
-- 'simple' is deliberate. Postgres ships no Arabic dictionary, and 'english'
-- would stem Arabic into nonsense. 'simple' tokenises on word boundaries
-- without stemming, which is correct for Arabic and adequate for English —
-- and it is the only configuration that treats both languages the same way.
--
-- Every input is coalesced BEFORE concatenation: tsvector || NULL is NULL, so
-- one absent field would otherwise silently erase the entire vector.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION document_metadata_search_vector_update()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector :=
       setweight(to_tsvector('simple', f_unaccent(coalesce(NEW.title, ''))), 'A')
    || setweight(to_tsvector('simple', f_unaccent(coalesce(array_to_string(NEW.keywords, ' '), ''))), 'B')
    || setweight(to_tsvector('simple', f_unaccent(coalesce(NEW.description, ''))), 'C')
    || setweight(to_tsvector('simple', f_unaccent(coalesce(NEW.summary, ''))), 'C')
    || setweight(to_tsvector('simple', f_unaccent(coalesce(NEW.extracted_text, ''))), 'D');
  RETURN NEW;
END
$$;

CREATE TRIGGER document_metadata_search_vector
  BEFORE INSERT OR UPDATE OF title, description, summary, extracted_text, keywords
  ON "document_metadata"
  FOR EACH ROW
  EXECUTE FUNCTION document_metadata_search_vector_update();

-- Backfill rows that already existed. UPDATE ... OF fires on the columns named
-- in SET, whether or not the value actually changed, so this is enough.
UPDATE "document_metadata" SET title = title;

-- ---------------------------------------------------------------------------
-- Search indexes
-- ---------------------------------------------------------------------------

-- Ranked full-text lookup.
CREATE INDEX "document_metadata_search_vector_idx"
  ON "document_metadata" USING GIN ("search_vector");

-- Typo tolerance on filenames. pg_trgm turns similarity() and ILIKE '%…%' into
-- index scans; without this, fuzzy matching degrades to a sequential scan over
-- every document in the company.
CREATE INDEX "documents_name_trgm_idx"
  ON "documents" USING GIN ("name" gin_trgm_ops);

-- No index on document_metadata.embedding yet, on purpose. The column is
-- dormant (see schema.prisma), and an HNSW index over all-NULL values costs
-- build time and write amplification to answer nothing. Add one in the same
-- migration that first populates embeddings.

-- ---------------------------------------------------------------------------
-- One open approval per document.
--
-- A partial unique index rather than application-level checking: two concurrent
-- requests would both pass a SELECT-then-INSERT check and both succeed. This
-- makes the second one a constraint violation, which the API turns into a 409.
-- Decided rows are exempt, so a document can be re-submitted after a rejection.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "approval_requests_one_pending_per_document"
  ON "approval_requests" ("document_id")
  WHERE "status" = 'PENDING';
