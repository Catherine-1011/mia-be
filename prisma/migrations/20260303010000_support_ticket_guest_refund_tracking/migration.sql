-- Make support ticket user link optional for guest workflows
ALTER TABLE "support_tickets"
ALTER COLUMN "userId" DROP NOT NULL;

-- Add structured fields for refund request tracking
ALTER TABLE "support_tickets"
ADD COLUMN IF NOT EXISTS "orderId" TEXT,
ADD COLUMN IF NOT EXISTS "guestEmail" TEXT,
ADD COLUMN IF NOT EXISTS "requestType" TEXT;

-- Helpful indexes for guest + customer refund tracking queries
CREATE INDEX IF NOT EXISTS "support_tickets_orderId_idx" ON "support_tickets"("orderId");
CREATE INDEX IF NOT EXISTS "support_tickets_guestEmail_idx" ON "support_tickets"("guestEmail");
