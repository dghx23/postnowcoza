-- Map PostNow payments to Zoho Books invoices/contacts
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "zohoBooksInvoiceId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "zohoBooksContactId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "zohoBooksPaymentId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "zohoBooksSyncedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "zohoBooksSyncError" TEXT;
