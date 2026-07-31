-- Midl: escrow + courier for peer-to-peer trade.
--
-- NOTE: this migration was authored by hand against schema.prisma and has
-- NOT been run against a live database (no DATABASE_URL / DB available in
-- the environment that wrote it). Review it and run
--   npx prisma migrate dev
-- (or `migrate deploy` in CI) against a real Postgres instance before
-- trusting it — do not assume it applies cleanly untested.

-- 1. New enums -----------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KycStatus') THEN
    CREATE TYPE "KycStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DealPlan') THEN
    CREATE TYPE "DealPlan" AS ENUM ('ESSENTIALS', 'STANDARD', 'VERIFIED_DELIVERY', 'PREMIUM_VAULT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DealState') THEN
    CREATE TYPE "DealState" AS ENUM (
      'DRAFT', 'FUNDED', 'REPORT_PENDING', 'REPORT_ISSUED', 'DISPATCHED',
      'DELIVERED', 'RELEASED', 'REFUND_PENDING', 'REFUNDED', 'DISPUTED', 'CANCELLED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CourierPayer') THEN
    CREATE TYPE "CourierPayer" AS ENUM ('BUYER', 'SELLER', 'INCLUDED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LedgerEntryType') THEN
    CREATE TYPE "LedgerEntryType" AS ENUM ('HOLD', 'RELEASE', 'REFUND', 'FEE_CAPTURE', 'COURIER_CHARGE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ConditionReportStage') THEN
    CREATE TYPE "ConditionReportStage" AS ENUM ('INTAKE', 'PRE_DISPATCH');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BuyerResponse') THEN
    CREATE TYPE "BuyerResponse" AS ENUM ('PENDING', 'ACCEPTED', 'FLAGGED');
  END IF;
END $$;

-- 2. User: add kycStatus ---------------------------------------------------

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "kycStatus" "KycStatus" NOT NULL DEFAULT 'UNVERIFIED';

-- 3. Deal --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "Deal" (
    "id"               TEXT NOT NULL,
    "reference"        TEXT NOT NULL,
    "plan"             "DealPlan" NOT NULL,
    "state"            "DealState" NOT NULL DEFAULT 'DRAFT',

    "buyerId"          TEXT NOT NULL,
    "sellerId"         TEXT NOT NULL,

    "itemName"         TEXT NOT NULL,
    "itemValueCents"   INTEGER NOT NULL,
    "itemCategory"     TEXT,

    "courierPayer"     "CourierPayer" NOT NULL DEFAULT 'INCLUDED',

    "feeCents"         INTEGER NOT NULL DEFAULT 0,
    "courierCents"     INTEGER NOT NULL DEFAULT 0,
    "insuranceCents"   INTEGER NOT NULL DEFAULT 0,
    "totalHeldCents"   INTEGER NOT NULL DEFAULT 0,

    "pickupStreet"     TEXT,
    "pickupCity"       TEXT,
    "pickupProvince"   TEXT,
    "pickupPostal"     TEXT,
    "deliveryStreet"   TEXT NOT NULL,
    "deliveryCity"     TEXT NOT NULL,
    "deliveryProvince" TEXT NOT NULL,
    "deliveryPostal"   TEXT NOT NULL,

    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Deal_reference_key" ON "Deal"("reference");
CREATE INDEX IF NOT EXISTS "Deal_buyerId_idx" ON "Deal"("buyerId");
CREATE INDEX IF NOT EXISTS "Deal_sellerId_idx" ON "Deal"("sellerId");
CREATE INDEX IF NOT EXISTS "Deal_state_idx" ON "Deal"("state");

ALTER TABLE "Deal" ADD CONSTRAINT "Deal_buyerId_fkey"
  FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. LedgerEntry (append-only) ------------------------------------------

CREATE TABLE IF NOT EXISTS "LedgerEntry" (
    "id"          TEXT NOT NULL,
    "dealId"      TEXT NOT NULL,
    "type"        "LedgerEntryType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "providerRef" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LedgerEntry_dealId_idx" ON "LedgerEntry"("dealId");

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. ConditionReport -------------------------------------------------------

CREATE TABLE IF NOT EXISTS "ConditionReport" (
    "id"               TEXT NOT NULL,
    "dealId"           TEXT NOT NULL,
    "stage"            "ConditionReportStage" NOT NULL,

    "photoKeys"        JSONB NOT NULL,
    "videoUrl"         TEXT,
    "notes"            TEXT,
    "serialNumber"     TEXT,
    "functionalPass"   BOOLEAN,

    "issuedToBuyerAt"  TIMESTAMP(3),
    "issuedToSellerAt" TIMESTAMP(3),
    "payloadHash"      TEXT,

    "buyerResponse"    "BuyerResponse" NOT NULL DEFAULT 'PENDING',
    "buyerRespondedAt" TIMESTAMP(3),

    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConditionReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ConditionReport_dealId_idx" ON "ConditionReport"("dealId");

ALTER TABLE "ConditionReport" ADD CONSTRAINT "ConditionReport_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Make AuditEvent / BobgoShipment shareable with Deal ------------------
--
-- Both were previously hard-tied to Document (NOT NULL documentId). This
-- makes documentId nullable and adds an equally-nullable dealId, so a row
-- belongs to exactly one of {Document, Deal} — enforced by the CHECK
-- constraints below since Prisma has no native polymorphic-relation
-- support. Existing rows are all Document-owned and satisfy the CHECK
-- unchanged (documentId IS NOT NULL, dealId IS NULL).

ALTER TABLE "AuditEvent" ALTER COLUMN "documentId" DROP NOT NULL;
ALTER TABLE "AuditEvent" ADD COLUMN IF NOT EXISTS "dealId" TEXT;
CREATE INDEX IF NOT EXISTS "AuditEvent_dealId_idx" ON "AuditEvent"("dealId");
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_owner_check"
  CHECK (num_nonnulls("documentId", "dealId") = 1);

ALTER TABLE "BobgoShipment" ALTER COLUMN "documentId" DROP NOT NULL;
ALTER TABLE "BobgoShipment" ADD COLUMN IF NOT EXISTS "dealId" TEXT;
CREATE INDEX IF NOT EXISTS "BobgoShipment_dealId_idx" ON "BobgoShipment"("dealId");
ALTER TABLE "BobgoShipment" ADD CONSTRAINT "BobgoShipment_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BobgoShipment" ADD CONSTRAINT "BobgoShipment_owner_check"
  CHECK (num_nonnulls("documentId", "dealId") = 1);
