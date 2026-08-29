ALTER TABLE "pending_registrations"
ADD COLUMN "otpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "otpConsumedAt" TIMESTAMP(3);

ALTER TABLE "login_verifications"
ADD COLUMN "otpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "otpConsumedAt" TIMESTAMP(3);
