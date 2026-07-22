-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "stripe_webhook_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "stripe_account_id" TEXT,
    "payment_intent_id" TEXT,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stripe_webhook_events_event_id_key" ON "stripe_webhook_events"("event_id");

-- CreateIndex
CREATE INDEX "stripe_webhook_events_status_idx" ON "stripe_webhook_events"("status");

-- CreateIndex
CREATE INDEX "stripe_webhook_events_event_type_idx" ON "stripe_webhook_events"("event_type");

-- CreateIndex
CREATE INDEX "stripe_webhook_events_stripe_account_id_idx" ON "stripe_webhook_events"("stripe_account_id");

-- CreateIndex
CREATE INDEX "stripe_webhook_events_payment_intent_id_idx" ON "stripe_webhook_events"("payment_intent_id");
