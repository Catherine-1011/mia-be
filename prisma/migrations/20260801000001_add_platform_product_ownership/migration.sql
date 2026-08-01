CREATE TYPE "ProductOwnerType" AS ENUM ('SELLER', 'PLATFORM');

CREATE TABLE "platform_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "payment_type" "PaymentAccountType" NOT NULL DEFAULT 'PLATFORM',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_accounts_user_id_key" ON "platform_accounts"("user_id");
CREATE INDEX "platform_accounts_active_idx" ON "platform_accounts"("active");
CREATE INDEX "platform_accounts_payment_type_idx" ON "platform_accounts"("payment_type");

ALTER TABLE "platform_accounts"
  ADD CONSTRAINT "platform_accounts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD COLUMN "creator_id" TEXT,
  ADD COLUMN "owner_type" "ProductOwnerType" NOT NULL DEFAULT 'SELLER',
  ADD COLUMN "platform_account_id" TEXT;

CREATE INDEX "products_creator_id_idx" ON "products"("creator_id");
CREATE INDEX "products_owner_type_idx" ON "products"("owner_type");
CREATE INDEX "products_platform_account_id_idx" ON "products"("platform_account_id");

ALTER TABLE "products"
  ADD CONSTRAINT "products_creator_id_fkey"
  FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD CONSTRAINT "products_platform_account_id_fkey"
  FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
