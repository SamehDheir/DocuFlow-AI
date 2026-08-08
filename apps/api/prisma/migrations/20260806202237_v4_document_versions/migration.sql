-- Carries the file's type and filename on each version, so a revert can restore
-- what the document WAS and not merely its bytes. Without these, reverting a
-- .docx that had been replaced by a .pdf would leave the parent row describing
-- the wrong file.
--
-- Hand-edited from Prisma's generated diff, which emitted both columns as NOT
-- NULL with no default and refused to run against a non-empty table. Added
-- nullable, backfilled, then constrained.
--
-- The backfill is exact rather than a guess: before v4 there was no route that
-- could append a version, so every existing row is version 1, written by the
-- upload pipeline under the same storage key as its parent document. The
-- document's own mime_type and original_name therefore still describe it.

-- AlterTable
ALTER TABLE "document_versions"
  ADD COLUMN "mime_type" TEXT,
  ADD COLUMN "original_name" TEXT,
  ADD COLUMN "note" TEXT;

-- Backfill from the parent document.
UPDATE "document_versions" AS v
SET "mime_type" = d."mime_type",
    "original_name" = d."original_name"
FROM "documents" AS d
WHERE d."id" = v."document_id";

-- Any row whose document has since been hard-deleted would be orphaned by the
-- FK, so this cannot match anything — but the constraint below is only safe if
-- nothing is left NULL, and asserting that is cheaper than assuming it.
UPDATE "document_versions"
SET "mime_type" = 'application/octet-stream'
WHERE "mime_type" IS NULL;

UPDATE "document_versions"
SET "original_name" = 'unknown'
WHERE "original_name" IS NULL;

ALTER TABLE "document_versions"
  ALTER COLUMN "mime_type" SET NOT NULL,
  ALTER COLUMN "original_name" SET NOT NULL;
