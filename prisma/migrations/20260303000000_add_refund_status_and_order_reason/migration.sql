-- Add REFUND and PARTIAL_REFUND values to OrderStatus enum
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'REFUND';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PARTIAL_REFUND';

-- Add status reason field to orders table for cancellation/refund rationale
ALTER TABLE "orders"
ADD COLUMN IF NOT EXISTS "statusReason" TEXT;
