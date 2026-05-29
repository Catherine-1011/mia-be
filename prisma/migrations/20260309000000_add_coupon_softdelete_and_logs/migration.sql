-- Migration: 20260309000000_add_coupon_softdelete_and_logs
-- Adds soft-delete / recycle-bin support to the coupons table.
-- Audit events are covered by the existing audit_logs table
-- via entityType = 'COUPON'.

-- Add soft-delete columns to coupons
ALTER TABLE "coupons"
  ADD COLUMN IF NOT EXISTS "soft_deleted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "soft_deleted_by" TEXT,
  ADD COLUMN IF NOT EXISTS "restored_at"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "restored_by"     TEXT;

-- Index for quick "active coupons only" queries (soft_deleted_at IS NULL)
CREATE INDEX IF NOT EXISTS "coupons_soft_deleted_at_idx"
  ON "coupons" ("soft_deleted_at");
