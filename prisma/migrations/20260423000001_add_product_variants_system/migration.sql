-- Add ProductType enum
CREATE TYPE "ProductType" AS ENUM ('SIMPLE', 'VARIABLE');

-- Add type column to products table with SIMPLE as default for backward compatibility
ALTER TABLE "products" 
ADD COLUMN "type" "ProductType" NOT NULL DEFAULT 'SIMPLE';

-- Add index for the new type column
CREATE INDEX "products_type_idx" ON "products"("type");

-- Create new attribute system tables
CREATE TABLE "attributes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attributes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attributes_name_key" ON "attributes"("name");
CREATE INDEX "attributes_name_idx" ON "attributes"("name");

CREATE TABLE "attribute_values" (
    "id" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "displayValue" TEXT NOT NULL,
    "hexColor" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attribute_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attribute_values_attributeId_value_key" ON "attribute_values"("attributeId", "value");
CREATE INDEX "attribute_values_attributeId_idx" ON "attribute_values"("attributeId");

CREATE TABLE "variant_attribute_values" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "attributeValueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_attribute_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "variant_attribute_values_variantId_attributeValueId_key" ON "variant_attribute_values"("variantId", "attributeValueId");
CREATE INDEX "variant_attribute_values_variantId_idx" ON "variant_attribute_values"("variantId");
CREATE INDEX "variant_attribute_values_attributeValueId_idx" ON "variant_attribute_values"("attributeValueId");

-- Transform existing product_variants table
-- First, add the new columns if they don't exist
DO $$ 
BEGIN
    -- Add productId column if using old product_id
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_variants' AND column_name = 'productId') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_variants' AND column_name = 'product_id') THEN
            -- Rename product_id to productId
            ALTER TABLE "product_variants" RENAME COLUMN "product_id" TO "productId";
        ELSE
            -- Add productId column with a default empty string (will be updated later)
            ALTER TABLE "product_variants" ADD COLUMN "productId" TEXT;
        END IF;
    END IF;

    -- Add updatedAt column if using old updated_at
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_variants' AND column_name = 'updatedAt') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_variants' AND column_name = 'updated_at') THEN
            -- Rename updated_at to updatedAt
            ALTER TABLE "product_variants" RENAME COLUMN "updated_at" TO "updatedAt";
        ELSE
            -- Add updatedAt column with current timestamp
            ALTER TABLE "product_variants" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
        END IF;
    END IF;

    -- Add createdAt column if using old created_at
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_variants' AND column_name = 'createdAt') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_variants' AND column_name = 'created_at') THEN
            -- Rename created_at to createdAt
            ALTER TABLE "product_variants" RENAME COLUMN "created_at" TO "createdAt";
        ELSE
            -- Add createdAt column with current timestamp
            ALTER TABLE "product_variants" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
        END IF;
    END IF;

    -- Add isActive column if using old is_active
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_variants' AND column_name = 'isActive') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'product_variants' AND column_name = 'is_active') THEN
            -- Rename is_active to isActive
            ALTER TABLE "product_variants" RENAME COLUMN "is_active" TO "isActive";
        ELSE
            -- Add isActive column with default true
            ALTER TABLE "product_variants" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
        END IF;
    END IF;
END $$;

-- Update cart_items table to use new column names
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cart_items' AND column_name = 'variant_id') THEN
        ALTER TABLE "cart_items" RENAME COLUMN "variant_id" TO "variantId";
    END IF;
END $$;

-- Update order_items table to use new column names
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'order_items' AND column_name = 'variant_id') THEN
        ALTER TABLE "order_items" RENAME COLUMN "variant_id" TO "variantId";
    END IF;
END $$;

-- Add foreign key constraints for the new attribute system
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "variant_attribute_values" ADD CONSTRAINT "variant_attribute_values_attributeValueId_fkey" FOREIGN KEY ("attributeValueId") REFERENCES "attribute_values"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Make productId NOT NULL after ensuring all rows have valid data
UPDATE "product_variants" SET "productId" = 'temp_product_id' WHERE "productId" IS NULL OR "productId" = '';

-- Now make it NOT NULL
ALTER TABLE "product_variants" ALTER COLUMN "productId" SET NOT NULL;

-- Add the foreign key constraint for productId
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Update cart items foreign key
DO $$
BEGIN
    -- Drop old constraint if exists
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'cart_items_variant_id_fkey') THEN
        ALTER TABLE "cart_items" DROP CONSTRAINT "cart_items_variant_id_fkey";
    END IF;
    
    -- Add new constraint
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'cart_items_variantId_fkey') THEN
        ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- Update order items foreign key
DO $$
BEGIN
    -- Drop old constraint if exists
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'order_items_variant_id_fkey') THEN
        ALTER TABLE "order_items" DROP CONSTRAINT "order_items_variant_id_fkey";
    END IF;
    
    -- Add new constraint
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'order_items_variantId_fkey') THEN
        ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id");
    END IF;
END $$;

-- Update indexes
DROP INDEX IF EXISTS "cart_items_cartId_productId_variant_id_idx";
DROP INDEX IF EXISTS "cart_items_variant_id_idx";
DROP INDEX IF EXISTS "order_items_variant_id_idx";

CREATE INDEX "cart_items_cartId_productId_variantId_idx" ON "cart_items"("cartId", "productId", "variantId");
CREATE INDEX "cart_items_variantId_idx" ON "cart_items"("variantId");
CREATE INDEX "order_items_variantId_idx" ON "order_items"("variantId");
CREATE INDEX "product_variants_sku_idx" ON "product_variants"("sku");