ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';

ALTER TABLE "order_payment_records"
  ADD COLUMN "stripe_dispute_id" TEXT;

CREATE INDEX "order_payment_records_stripe_dispute_id_idx"
  ON "order_payment_records"("stripe_dispute_id");
