CREATE TABLE "api_idempotency_operations" (
  "id" TEXT NOT NULL,
  "operation_key" TEXT NOT NULL,
  "operation_type" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'STARTED',
  "stripe_payment_intent_id" TEXT,
  "order_id" TEXT,
  "attempt_number" INTEGER NOT NULL DEFAULT 1,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "api_idempotency_operations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_idempotency_operations_operation_key_key"
  ON "api_idempotency_operations"("operation_key");

CREATE INDEX "api_idempotency_operations_operation_type_idx"
  ON "api_idempotency_operations"("operation_type");

CREATE INDEX "api_idempotency_operations_stripe_payment_intent_id_idx"
  ON "api_idempotency_operations"("stripe_payment_intent_id");

CREATE INDEX "api_idempotency_operations_order_id_idx"
  ON "api_idempotency_operations"("order_id");
