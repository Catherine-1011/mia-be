-- Safe migration script to add isActive field to products table
-- Run this manually in your database to avoid data loss

-- Add isActive column with default value false
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT false;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS "products_isActive_idx" ON "products"("isActive");

-- Update existing products based on current status
-- Set isActive = true for products that are already ACTIVE
UPDATE "products" 
SET "isActive" = true 
WHERE "status" = 'ACTIVE';

-- Set isActive = false for products that are PENDING or INACTIVE
UPDATE "products" 
SET "isActive" = false 
WHERE "status" IN ('PENDING', 'INACTIVE');

-- Verify the changes
SELECT 
    "status",
    "isActive",
    COUNT(*) as count
FROM "products" 
GROUP BY "status", "isActive"
ORDER BY "status", "isActive";