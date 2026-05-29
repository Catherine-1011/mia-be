-- SSO Tickets: one-time handshake tokens for cross-domain auth (Sellers & Customers only)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS sso_tickets (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId"    TEXT        NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT sso_tickets_userId_fkey
    FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sso_tickets_userId_idx    ON sso_tickets ("userId");
CREATE INDEX IF NOT EXISTS sso_tickets_expiresAt_idx ON sso_tickets ("expiresAt");
