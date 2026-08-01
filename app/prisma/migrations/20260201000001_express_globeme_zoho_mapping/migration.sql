-- Zoho Books mapping for PostNow Express (CourierBooking) and GlobeMe
-- (ShoppingOrder), mirroring the fields already on Payment (E2's flow).
-- Purely additive nullable columns.

ALTER TABLE "CourierBooking"
  ADD COLUMN IF NOT EXISTS "zohoBooksContactId" TEXT,
  ADD COLUMN IF NOT EXISTS "zohoBooksInvoiceId" TEXT,
  ADD COLUMN IF NOT EXISTS "zohoBooksPaymentId" TEXT,
  ADD COLUMN IF NOT EXISTS "zohoBooksSyncedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "zohoBooksSyncError" TEXT,
  ADD COLUMN IF NOT EXISTS "zohoBooksInvoiceStatus" TEXT;

ALTER TABLE "ShoppingOrder"
  ADD COLUMN IF NOT EXISTS "zohoBooksContactId" TEXT,
  ADD COLUMN IF NOT EXISTS "zohoBooksInvoiceId" TEXT,
  ADD COLUMN IF NOT EXISTS "zohoBooksPaymentId" TEXT,
  ADD COLUMN IF NOT EXISTS "zohoBooksSyncedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "zohoBooksSyncError" TEXT,
  ADD COLUMN IF NOT EXISTS "zohoBooksInvoiceStatus" TEXT;
