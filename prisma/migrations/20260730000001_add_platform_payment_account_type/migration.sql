CREATE TYPE "PaymentAccountType" AS ENUM ('CONNECTED', 'PLATFORM');

ALTER TABLE "seller_profiles"
  ADD COLUMN "payment_account_type" "PaymentAccountType" NOT NULL DEFAULT 'CONNECTED';

ALTER TYPE "PaymentFlow" ADD VALUE IF NOT EXISTS 'PLATFORM_ACCOUNT';

ALTER TABLE "payment_completion_outbox"
  DROP CONSTRAINT IF EXISTS "payment_completion_outbox_order_id_type_key";

CREATE UNIQUE INDEX IF NOT EXISTS "payment_completion_outbox_order_id_stripe_payment_intent_id_type_key"
  ON "payment_completion_outbox" ("order_id", "stripe_payment_intent_id", "type");
