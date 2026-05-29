-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add subDisplayId to sub_orders and backfill existing rows
-- Run this once against your production database BEFORE deploying the new code.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add the column (nullable, unique)
ALTER TABLE sub_orders
  ADD COLUMN IF NOT EXISTS "subDisplayId" TEXT;

-- 2. Backfill existing sub-orders
--    Format: {parentOrder.displayId}-{A,B,C,...}  (A = first seller, B = second, etc.)
--    Ordering is by sub-order createdAt within each parent to ensure stable assignment.
UPDATE sub_orders AS so
SET "subDisplayId" = o."displayId" || '-' || chr(64 + ranked.rn)
FROM (
  SELECT
    id,
    "parentOrderId",
    ROW_NUMBER() OVER (
      PARTITION BY "parentOrderId"
      ORDER BY "createdAt" ASC
    ) AS rn
  FROM sub_orders
  WHERE "subDisplayId" IS NULL
) AS ranked
JOIN orders o ON o.id = ranked."parentOrderId"
WHERE so.id = ranked.id
  AND so."subDisplayId" IS NULL;

-- 3. Add unique constraint (safe to run even if column already has values)
ALTER TABLE sub_orders
  ADD CONSTRAINT IF NOT EXISTS sub_orders_sub_display_id_key UNIQUE ("subDisplayId");

-- 4. Add index for fast lookup by subDisplayId
CREATE INDEX IF NOT EXISTS sub_orders_sub_display_id_idx ON sub_orders ("subDisplayId");
