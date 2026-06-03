-- Migration: Add site_settings table for admin-controlled global settings
-- Run this on the production database once

CREATE TABLE IF NOT EXISTS "site_settings" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "internationalShippingEnabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

-- Insert the single global settings row (safe to run multiple times)
INSERT INTO "site_settings" ("id", "internationalShippingEnabled", "updatedAt")
VALUES ('global', true, NOW())
ON CONFLICT ("id") DO NOTHING;
