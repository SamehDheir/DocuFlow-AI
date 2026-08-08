-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'DOCUMENT_COMMENTED';
ALTER TYPE "NotificationType" ADD VALUE 'DOCUMENT_VERSION_ADDED';

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_favorites" (
    "company_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_favorites_pkey" PRIMARY KEY ("user_id","document_id")
);

-- CreateIndex
CREATE INDEX "comments_company_id_document_id_created_at_idx" ON "comments"("company_id", "document_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_author_id_idx" ON "comments"("author_id");

-- CreateIndex
CREATE INDEX "document_favorites_company_id_user_id_created_at_idx" ON "document_favorites"("company_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "document_favorites_document_id_idx" ON "document_favorites"("document_id");

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_favorites" ADD CONSTRAINT "document_favorites_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_favorites" ADD CONSTRAINT "document_favorites_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_favorites" ADD CONSTRAINT "document_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
