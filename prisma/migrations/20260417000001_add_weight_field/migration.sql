-- Add weight field to products table with default value
-- This ensures existing products get a reasonable default weight

-- Add weight column with default value
ALTER TABLE "products" ADD COLUMN "weight" DECIMAL(8,2) NOT NULL DEFAULT 0.50;

-- Add a comment for documentation
COMMENT ON COLUMN "products"."weight" IS 'Product weight in kilograms (kg). Used for shipping calculations.';