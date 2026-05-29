-- Add valueType to Attribute table
-- "text" = letter sizes (S, M, L, XL), "number" = numeric sizes (6, 7, 8, 9)
-- Color attribute stays unaffected (defaults to "text")

ALTER TABLE "attributes" ADD COLUMN IF NOT EXISTS "valueType" TEXT NOT NULL DEFAULT 'text';
