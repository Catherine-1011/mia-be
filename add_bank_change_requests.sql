-- Add BankChangeStatus enum and bank_change_requests table
-- Run once against the live database

DO $$ BEGIN
  CREATE TYPE "BankChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "bank_change_requests" (
  "id"             TEXT NOT NULL,
  "sellerId"       TEXT NOT NULL,
  "newBankDetails" JSONB NOT NULL,
  "reason"         TEXT NOT NULL,
  "status"         "BankChangeStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedBy"     TEXT,
  "reviewNote"     TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bank_change_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_change_requests_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "seller_profiles"("userId") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "bank_change_requests_sellerId_idx" ON "bank_change_requests"("sellerId");
CREATE INDEX IF NOT EXISTS "bank_change_requests_status_idx"   ON "bank_change_requests"("status");
