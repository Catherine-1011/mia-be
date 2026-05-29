-- Add CommissionType enum
CREATE TYPE "CommissionType" AS ENUM ('FIXED', 'PERCENTAGE');

-- Create commissions table
CREATE TABLE "commissions" (
  "id"          TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "type"        "CommissionType" NOT NULL,
  "value"       DECIMAL(10,2) NOT NULL,
  "description" TEXT,
  "isDefault"   BOOLEAN NOT NULL DEFAULT false,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- Add commission_id to seller_profiles
ALTER TABLE "seller_profiles"
  ADD COLUMN "commission_id" TEXT;

ALTER TABLE "seller_profiles"
  ADD CONSTRAINT "seller_profiles_commission_id_fkey"
  FOREIGN KEY ("commission_id") REFERENCES "commissions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
