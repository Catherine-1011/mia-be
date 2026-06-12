-- Migration: Add Seller Inactive Feature
-- Purpose: Allow admins to deactivate sellers, preventing them from performing operations
-- Date: 2026-06-11
-- Description: Adds isActive, inactiveReason, deactivatedAt, and deactivatedBy fields to seller_profiles

-- Add new columns to seller_profiles table
ALTER TABLE seller_profiles
ADD COLUMN isActive BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN inactiveReason TEXT,
ADD COLUMN deactivatedAt TIMESTAMP,
ADD COLUMN deactivatedBy TEXT;

-- Create an index for quick lookups of inactive sellers
CREATE INDEX idx_seller_profiles_isactive ON seller_profiles(isActive);
CREATE INDEX idx_seller_profiles_deactivated_at ON seller_profiles(deactivatedAt);

-- Add sellerInactiveReason to products table to track why product was deactivated due to seller deactivation
ALTER TABLE products
ADD COLUMN sellerInactiveReason TEXT;

-- Create index for tracking products deactivated by seller deactivation
CREATE INDEX idx_products_seller_inactive_reason ON products(sellerInactiveReason);

-- Backfill existing data (optional): Set all existing sellers as active
UPDATE seller_profiles
SET isActive = true
WHERE isActive IS NULL;
