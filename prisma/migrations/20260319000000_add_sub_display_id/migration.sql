-- This migration previously failed due to a SQL bug in the backfill query.
-- It has been superseded by 20260319000001_add_sub_display_id_fix.
-- Kept as a no-op so prisma migrate deploy can mark it resolved.
SELECT 1;
