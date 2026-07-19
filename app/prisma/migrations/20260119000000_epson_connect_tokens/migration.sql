-- Durable Epson Connect device tokens (shared across staff / serverless).
-- Cookies alone cannot survive multi-browser or cold starts.
ALTER TABLE "PrintSettings" ADD COLUMN IF NOT EXISTS "epsonAccessToken" TEXT;
ALTER TABLE "PrintSettings" ADD COLUMN IF NOT EXISTS "epsonRefreshToken" TEXT;
ALTER TABLE "PrintSettings" ADD COLUMN IF NOT EXISTS "epsonTokenExpiresAt" TIMESTAMP(3);
