-- Add artistName and artistDescription to seller_profiles
ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "artistName" TEXT;
ALTER TABLE "seller_profiles" ADD COLUMN IF NOT EXISTS "artistDescription" TEXT;

-- Remove cultural approval columns (no longer needed)
ALTER TABLE "seller_profiles" DROP COLUMN IF EXISTS "culturalApprovalStatus";
ALTER TABLE "seller_profiles" DROP COLUMN IF EXISTS "culturalApprovalAt";
ALTER TABLE "seller_profiles" DROP COLUMN IF EXISTS "culturalApprovalFeedback";
ALTER TABLE "seller_profiles" DROP COLUMN IF EXISTS "culturalApprovalBy";
