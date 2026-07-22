CREATE TYPE "PaymentCompletionOutboxType" AS ENUM (
  'CUSTOMER_CONFIRMATION',
  'FINANCE_INVOICE',
  'ADMIN_NEW_ORDER_NOTIFICATION',
  'SELLER_NEW_ORDER_NOTIFICATION',
  'SELLER_PAYOUT_NOTIFICATION'
);

CREATE TYPE "PaymentCompletionOutboxStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED'
);

CREATE TABLE "payment_completion_outbox" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "stripe_payment_intent_id" TEXT,
  "type" "PaymentCompletionOutboxType" NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "PaymentCompletionOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "payment_completion_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_completion_outbox_order_id_type_key"
  ON "payment_completion_outbox"("order_id", "type");

CREATE INDEX "payment_completion_outbox_status_idx"
  ON "payment_completion_outbox"("status");

CREATE INDEX "payment_completion_outbox_stripe_payment_intent_id_idx"
  ON "payment_completion_outbox"("stripe_payment_intent_id");

ALTER TABLE "payment_completion_outbox"
  ADD CONSTRAINT "payment_completion_outbox_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
