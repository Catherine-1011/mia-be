-- Add SAML archive state and metadata.
-- Archived admins remain in saml_approvals for history, but cannot sign in
-- because SAML login only accepts APPROVED approvals.

ALTER TYPE "SamlApprovalStatus" ADD VALUE 'ARCHIVED';

ALTER TABLE "saml_approvals"
ADD COLUMN "archived_by" TEXT,
ADD COLUMN "archived_at" TIMESTAMP(3),
ADD COLUMN "archive_reason" TEXT;

CREATE INDEX "saml_approvals_archived_at_idx"
ON "saml_approvals"("archived_at");
