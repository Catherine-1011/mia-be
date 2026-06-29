-- CreateEnum
CREATE TYPE "SamlApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'BLOCKED');

-- CreateTable
CREATE TABLE "saml_approvals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SamlApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejected_by" TEXT,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "blocked_by" TEXT,
    "blocked_at" TIMESTAMP(3),
    "block_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saml_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saml_approvals_userId_key" ON "saml_approvals"("userId");

-- CreateIndex
CREATE INDEX "saml_approvals_status_idx" ON "saml_approvals"("status");

-- CreateIndex
CREATE INDEX "saml_approvals_created_at_idx" ON "saml_approvals"("created_at");

-- AddForeignKey
ALTER TABLE "saml_approvals" ADD CONSTRAINT "saml_approvals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: all existing SAML users get APPROVED status
INSERT INTO "saml_approvals" ("id", "userId", "status", "approved_by", "approved_at", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    "id",
    'APPROVED',
    'SYSTEM_MIGRATION',
    NOW(),
    NOW(),
    NOW()
FROM "users"
WHERE "password" = 'SAML_MANAGED_ACCOUNT_NO_PASSWORD';
