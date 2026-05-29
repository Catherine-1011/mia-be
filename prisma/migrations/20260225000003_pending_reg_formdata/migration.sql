-- Add formData column to pending_registrations for storing full onboarding payload
ALTER TABLE "pending_registrations" ADD COLUMN IF NOT EXISTS "form_data" JSONB;
