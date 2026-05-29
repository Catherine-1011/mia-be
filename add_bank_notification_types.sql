-- Add BANK_CHANGE_* values to the NotificationType enum
-- Run once against the live database after deploying the notification code
-- These values are required for in-app notifications on bank change-request events

-- PostgreSQL does not support IF NOT EXISTS on ALTER TYPE ADD VALUE in older versions,
-- but the DO block below handles duplicate protection gracefully.

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE 'BANK_CHANGE_REQUESTED';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE 'BANK_CHANGE_APPROVED';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE 'BANK_CHANGE_REJECTED';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
