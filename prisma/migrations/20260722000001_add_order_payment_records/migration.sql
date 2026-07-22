-- CreateEnum
CREATE TYPE "PaymentFlow" AS ENUM ('DIRECT_CHARGE', 'DESTINATION_CHARGE', 'SEPARATE_CHARGE_AND_TRANSFER', 'LEGACY_OR_UNKNOWN');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('NONE', 'PARTIAL', 'FULL', 'FAILED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('NONE', 'OPEN', 'WON', 'LOST');

-- CreateTable
CREATE TABLE "order_payment_records" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "seller_id" TEXT,
    "payment_flow" "PaymentFlow" NOT NULL DEFAULT 'LEGACY_OR_UNKNOWN',
    "stripe_account_id" TEXT,
    "stripe_payment_intent_id" TEXT NOT NULL,
    "stripe_charge_id" TEXT,
    "stripe_application_fee_id" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'aud',
    "gross_amount" INTEGER NOT NULL,
    "commission_base" INTEGER NOT NULL,
    "application_fee_amount" INTEGER NOT NULL,
    "gst_amount" INTEGER NOT NULL DEFAULT 0,
    "shipping_amount" INTEGER NOT NULL DEFAULT 0,
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "refund_status" "RefundStatus" NOT NULL DEFAULT 'NONE',
    "dispute_status" "DisputeStatus" NOT NULL DEFAULT 'NONE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_payment_records_pkey" PRIMARY KEY ("id")
);

-- Backfill historical Stripe orders conservatively.
-- DIRECT_CHARGE is intentionally not inferred for historical rows unless future
-- migration work adds stored Stripe proof. Uncertain rows remain LEGACY_OR_UNKNOWN.
WITH historical_payment_rollup AS (
  SELECT
    DISTINCT ON (o."stripePaymentIntentId")
    o."id" AS order_id,
    o."sellerId" AS order_seller_id,
    o."stripePaymentIntentId" AS stripe_payment_intent_id,
    o."totalAmount" AS order_total_amount,
    o."paymentStatus" AS payment_status,
    o."createdAt" AS created_at,
    o."updatedAt" AS updated_at,
    MIN(ce."seller_id") AS commission_seller_id,
    BOOL_OR(
      ce."stripe_transfer_id" IS NOT NULL
      OR ce."stripe_transfer_status" IN ('transferred', 'failed', 'reversed')
    ) AS has_separate_transfer_proof,
    COALESCE(SUM(ce."order_value"), 0) AS commission_order_value,
    COALESCE(SUM(ce."product_value_ex_gst"), 0) AS commission_product_value_ex_gst,
    COALESCE(SUM(ce."commission_amount"), 0) AS commission_amount,
    COALESCE(SUM(ce."gst_amount"), 0) AS gst_amount,
    COALESCE(SUM(ce."shipping_amount"), 0) AS shipping_amount
  FROM "orders" o
  LEFT JOIN "commission_earned" ce ON ce."order_id" = o."id"
  WHERE o."stripePaymentIntentId" IS NOT NULL
  GROUP BY o."id", o."sellerId", o."stripePaymentIntentId", o."totalAmount", o."paymentStatus", o."createdAt", o."updatedAt"
  ORDER BY o."stripePaymentIntentId", o."createdAt"
)
INSERT INTO "order_payment_records" (
    "id",
    "order_id",
    "seller_id",
    "payment_flow",
    "stripe_payment_intent_id",
    "currency",
    "gross_amount",
    "commission_base",
    "application_fee_amount",
    "gst_amount",
    "shipping_amount",
    "payment_status",
    "created_at",
    "updated_at"
)
SELECT
    'opr_' || md5(random()::text || clock_timestamp()::text || h.order_id || COALESCE(h.commission_seller_id, h.order_seller_id, '')),
    h.order_id,
    COALESCE(h.commission_seller_id, h.order_seller_id),
    CASE
      WHEN h.has_separate_transfer_proof
      THEN 'SEPARATE_CHARGE_AND_TRANSFER'::"PaymentFlow"
      ELSE 'LEGACY_OR_UNKNOWN'::"PaymentFlow"
    END,
    h.stripe_payment_intent_id,
    'aud',
    COALESCE(ROUND(COALESCE(NULLIF(h.commission_order_value, 0), h.order_total_amount, 0) * 100), 0)::INTEGER,
    COALESCE(ROUND(COALESCE(NULLIF(h.commission_product_value_ex_gst, 0), NULLIF(h.commission_order_value, 0), h.order_total_amount, 0) * 100), 0)::INTEGER,
    COALESCE(ROUND(COALESCE(h.commission_amount, 0) * 100), 0)::INTEGER,
    COALESCE(ROUND(COALESCE(h.gst_amount, 0) * 100), 0)::INTEGER,
    COALESCE(ROUND(COALESCE(h.shipping_amount, 0) * 100), 0)::INTEGER,
    h.payment_status,
    h.created_at,
    h.updated_at
FROM historical_payment_rollup h
ON CONFLICT DO NOTHING;

-- CreateIndex
CREATE UNIQUE INDEX "order_payment_records_stripe_payment_intent_id_key" ON "order_payment_records"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "order_payment_records_order_id_idx" ON "order_payment_records"("order_id");

-- CreateIndex
CREATE INDEX "order_payment_records_seller_id_idx" ON "order_payment_records"("seller_id");

-- CreateIndex
CREATE INDEX "order_payment_records_payment_flow_idx" ON "order_payment_records"("payment_flow");

-- CreateIndex
CREATE INDEX "order_payment_records_stripe_account_id_idx" ON "order_payment_records"("stripe_account_id");

-- CreateIndex
CREATE INDEX "order_payment_records_stripe_charge_id_idx" ON "order_payment_records"("stripe_charge_id");

-- AddForeignKey
ALTER TABLE "order_payment_records" ADD CONSTRAINT "order_payment_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_payment_records" ADD CONSTRAINT "order_payment_records_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
