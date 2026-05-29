-- Migration: Add Stripe Connect fields to seller_profiles
-- Run this against your PostgreSQL database before deploying the Stripe Connect feature.

ALTER TABLE seller_profiles
  ADD COLUMN IF NOT EXISTS stripe_account_id          VARCHAR(255),
  ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled     BOOLEAN NOT NULL DEFAULT false;

-- Optional index for quick lookups by stripe account
CREATE INDEX IF NOT EXISTS idx_seller_profiles_stripe_account_id
  ON seller_profiles (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;
