/*
  Warnings:

  - You are about to drop the column `taxId` on the `seller_profiles` table. All the data in the column will be lost.
  - You are about to drop the column `verificationDocs` on the `seller_profiles` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "seller_profiles" DROP COLUMN "taxId",
DROP COLUMN "verificationDocs",
ADD COLUMN     "abn" TEXT,
ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "activatedBy" TEXT,
ADD COLUMN     "adminNotes" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "contactPerson" TEXT,
ADD COLUMN     "culturalApprovalAt" TIMESTAMP(3),
ADD COLUMN     "culturalApprovalBy" TEXT,
ADD COLUMN     "culturalApprovalFeedback" TEXT,
ADD COLUMN     "culturalApprovalStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "culturalBackground" TEXT,
ADD COLUMN     "culturalStory" TEXT,
ADD COLUMN     "kycDocuments" JSONB,
ADD COLUMN     "kycSubmitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "onboardingStep" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "storeBanner" TEXT,
ADD COLUMN     "storeDescription" TEXT,
ADD COLUMN     "storeLocation" TEXT,
ADD COLUMN     "storeLogo" TEXT,
ADD COLUMN     "submittedForReviewAt" TIMESTAMP(3),
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspensionReason" TEXT,
ADD COLUMN     "website" TEXT,
ADD COLUMN     "yearsInBusiness" INTEGER,
ALTER COLUMN "businessName" DROP NOT NULL,
ALTER COLUMN "businessAddress" SET DATA TYPE TEXT;
