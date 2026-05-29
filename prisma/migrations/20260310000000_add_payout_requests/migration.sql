-- Add PayoutRequestStatus enum
CREATE TYPE "PayoutRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED');

-- Create payout_requests table
CREATE TABLE "payout_requests" (
  "id"                     TEXT NOT NULL,
  "seller_id"              TEXT NOT NULL,
  "requested_amount"       DECIMAL(10,2) NOT NULL,
  "redeemable_at_request"  DECIMAL(10,2) NOT NULL,
  "status"                 "PayoutRequestStatus" NOT NULL DEFAULT 'PENDING',
  "seller_note"            TEXT,
  "admin_note"             TEXT,
  "processed_at"           TIMESTAMP(3),
  "processed_by"           TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payout_requests"
  ADD CONSTRAINT "payout_requests_seller_id_fkey"
  FOREIGN KEY ("seller_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "payout_requests_seller_id_idx" ON "payout_requests"("seller_id");
CREATE INDEX "payout_requests_status_idx"    ON "payout_requests"("status");
