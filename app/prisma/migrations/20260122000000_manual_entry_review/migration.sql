-- Waived: staff processed a job at no cost (at PostNow's expense). Dispatch
-- proceeds as if paid, but it's tracked separately from real revenue.
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'WAIVED';

-- Manual-entry accountability, captured on the staff "Request payment of
-- dispatch fee" screen before sending, cancelling, or waiving.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "manualEntryJustification" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "isTestEntry" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "cancelledJustification" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "waivedAmount" DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "waivedJustification" TEXT;
