-- Add email verification deadline and reminder tracking fields to users table
-- These fields are optional and will be NULL for existing users
ALTER TABLE "users" ADD COLUMN "emailVerificationDeadline" TIMESTAMP(3),
ADD COLUMN "emailVerificationReminderSentAt" TIMESTAMP(3);
