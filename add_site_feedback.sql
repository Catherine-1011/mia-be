-- Create site_feedback table for website feedback (star rating + comment)
CREATE TABLE IF NOT EXISTS "site_feedback" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT,
  "name"      TEXT,
  "email"     TEXT,
  "rating"    SMALLINT NOT NULL,
  "comment"   TEXT,
  "page"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "site_feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_feedback_rating_check" CHECK ("rating" >= 1 AND "rating" <= 5),
  CONSTRAINT "site_feedback_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "site_feedback_userId_idx" ON "site_feedback"("userId");
CREATE INDEX IF NOT EXISTS "site_feedback_rating_idx"  ON "site_feedback"("rating");
