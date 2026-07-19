-- Zoho pull snapshot fields on Payment
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "zohoBooksInvoiceStatus" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "zohoBooksBalance" DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "zohoBooksLastPullAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "billingItemId" TEXT;

-- Billing / payment-structure workspace
CREATE TABLE IF NOT EXISTS "BillingItem" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "zohoItemId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BillingItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BillingItem_code_key" ON "BillingItem"("code");

-- Sync exception log (Zoho two-way + structure)
CREATE TABLE IF NOT EXISTS "SyncException" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'error',
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "paymentId" TEXT,
    "documentId" TEXT,
    "metadata" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "SyncException_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SyncException_resolved_createdAt_idx" ON "SyncException"("resolved", "createdAt");
CREATE INDEX IF NOT EXISTS "SyncException_source_idx" ON "SyncException"("source");

-- Facility scans
CREATE TABLE IF NOT EXISTS "FacilityScan" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/pdf',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "comments" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FacilityScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FacilityScan_createdAt_idx" ON "FacilityScan"("createdAt");

-- FK Payment → BillingItem
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Payment_billingItemId_fkey'
  ) THEN
    ALTER TABLE "Payment"
      ADD CONSTRAINT "Payment_billingItemId_fkey"
      FOREIGN KEY ("billingItemId") REFERENCES "BillingItem"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Payment_billingItemId_idx" ON "Payment"("billingItemId");
