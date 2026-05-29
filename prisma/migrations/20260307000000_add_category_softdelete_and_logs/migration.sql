-- Migration: 20260307000000_add_category_softdelete_and_logs
-- Adds soft-delete support to category_requests.
-- The audit_logs table already exists and covers all category events
-- via entityType = 'CATEGORY'.

-- Add soft-delete columns to category_requests
ALTER TABLE "category_requests"
  ADD COLUMN IF NOT EXISTS "softDeletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "softDeletedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "restoredAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "restoredBy"    TEXT;

-- Index for quick "active categories only" queries
CREATE INDEX IF NOT EXISTS "category_requests_softDeletedAt_idx"
  ON "category_requests" ("softDeletedAt");
