-- Migration: Add variant support to wishlist
-- This migration adds variantId column and updates constraints

-- Add variantId column to wishlists table
ALTER TABLE "wishlists" ADD COLUMN "variantId" TEXT;

-- Add foreign key constraint for variantId
ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_variantId_fkey" 
  FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop the old unique constraint
ALTER TABLE "wishlists" DROP CONSTRAINT "wishlists_userId_productId_key";

-- Add new unique constraint that includes variantId
ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_userId_productId_variantId_key" 
  UNIQUE ("userId", "productId", "variantId");

-- Add index for variantId
CREATE INDEX "wishlists_variantId_idx" ON "wishlists"("variantId");