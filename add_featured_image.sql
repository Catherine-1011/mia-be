-- Add featuredImage column to products table
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "featuredImage" TEXT DEFAULT NULL;

-- Migrate existing data: set featuredImage to the first element of the images array (if any)
UPDATE "products"
SET "featuredImage" = images[1]
WHERE "featuredImage" IS NULL AND array_length(images, 1) > 0;
