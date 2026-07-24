-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM (
  'COLLECTING_PAYMENT_METHOD',
  'CHARGING_SELLERS',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED'
);

-- CreateTable
CREATE TABLE "multi_seller_checkout_sessions" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "platform_customer_id" TEXT NOT NULL,
  "platform_setup_intent_id" TEXT NOT NULL,
  "platform_payment_method_id" TEXT,
  "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'COLLECTING_PAYMENT_METHOD',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "multi_seller_checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "multi_seller_checkout_sessions_order_id_key"
  ON "multi_seller_checkout_sessions"("order_id");

-- AddForeignKey
ALTER TABLE "multi_seller_checkout_sessions"
  ADD CONSTRAINT "multi_seller_checkout_sessions_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
