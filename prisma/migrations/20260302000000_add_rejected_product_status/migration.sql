-- Add REJECTED value to ProductStatus enum
-- This is a purely additive change — no data is modified or deleted.
ALTER TYPE "ProductStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
