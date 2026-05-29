-- Add subDisplayId column to sub_orders (idempotent — safe to re-run)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sub_orders' AND column_name = 'subDisplayId'
  ) THEN
    ALTER TABLE "sub_orders" ADD COLUMN "subDisplayId" TEXT;
  END IF;
END $$;

-- Backfill existing rows that have no subDisplayId yet
-- Format: {parentOrder.displayId}-A, -B, -C, ... ordered by sub-order createdAt
UPDATE "sub_orders" AS so
SET "subDisplayId" = o."displayId" || '-' || chr((64 + ranked.rn)::int)
FROM (
  SELECT
    id,
    "parentOrderId",
    ROW_NUMBER() OVER (
      PARTITION BY "parentOrderId"
      ORDER BY "createdAt" ASC
    ) AS rn
  FROM "sub_orders"
  WHERE "subDisplayId" IS NULL
) AS ranked
JOIN "orders" o ON o.id = ranked."parentOrderId"
WHERE so.id = ranked.id;

-- Add unique constraint (only if it doesn't already exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sub_orders_subDisplayId_key'
  ) THEN
    ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_subDisplayId_key" UNIQUE ("subDisplayId");
  END IF;
END $$;
