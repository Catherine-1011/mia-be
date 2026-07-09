-- Add SAML NameID binding metadata for post-WatchGuard ALPA email verification.
-- All columns are nullable/defaulted so this can be deployed before application code.

ALTER TABLE "saml_approvals"
ADD COLUMN "saml_subject" TEXT,
ADD COLUMN "saml_name_id_format" TEXT,
ADD COLUMN "saml_email_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "saml_binding_completed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "saml_bound_at" TIMESTAMP(3),
ADD COLUMN "saml_pending_subject" TEXT,
ADD COLUMN "saml_verification_token" TEXT,
ADD COLUMN "saml_verification_expires_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "saml_approvals_saml_subject_key"
ON "saml_approvals"("saml_subject");

CREATE UNIQUE INDEX "saml_approvals_saml_verification_token_key"
ON "saml_approvals"("saml_verification_token");

CREATE INDEX "saml_approvals_saml_pending_subject_idx"
ON "saml_approvals"("saml_pending_subject");

CREATE INDEX "saml_approvals_saml_verification_expires_at_idx"
ON "saml_approvals"("saml_verification_expires_at");
