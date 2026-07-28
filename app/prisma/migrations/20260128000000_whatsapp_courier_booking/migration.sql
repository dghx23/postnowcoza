-- WhatsApp courier-booking offering: book a pickup/locker drop-off entirely
-- over WhatsApp and pay via PayShap Request-to-Pay (src/lib/whatsappBookingBot.ts).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CourierBookingStatus') THEN
    CREATE TYPE "CourierBookingStatus" AS ENUM (
      'DRAFT', 'AWAITING_PAYMENT', 'PAID', 'COURIER_ASSIGNED',
      'COLLECTED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CourierBookingPickupType') THEN
    CREATE TYPE "CourierBookingPickupType" AS ENUM ('DOOR', 'LOCKER', 'BUSINESS');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "CourierBooking" (
    "id"               TEXT NOT NULL,
    "bookingRef"       TEXT NOT NULL,
    "status"           "CourierBookingStatus" NOT NULL DEFAULT 'DRAFT',
    "senderPhone"      TEXT NOT NULL,
    "pickupType"       "CourierBookingPickupType" NOT NULL DEFAULT 'DOOR',
    "pickupAddress"    TEXT,
    "pickupLat"        DOUBLE PRECISION,
    "pickupLng"        DOUBLE PRECISION,
    "recipientName"    TEXT,
    "recipientPhone"   TEXT,
    "recipientAddress" TEXT,
    "parcels"          JSONB NOT NULL,
    "serviceLevel"     TEXT,
    "courier"          TEXT,
    "price"            DOUBLE PRECISION,
    "insurance"        BOOLEAN NOT NULL DEFAULT false,
    "scheduledDate"    TEXT,
    "instructions"     TEXT,
    "payShapRequestId" TEXT,
    "paidAt"           TIMESTAMP(3),
    "bobgoShipmentId"  TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CourierBooking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CourierBooking_bookingRef_key" ON "CourierBooking"("bookingRef");
CREATE INDEX IF NOT EXISTS "CourierBooking_senderPhone_idx" ON "CourierBooking"("senderPhone");
CREATE INDEX IF NOT EXISTS "CourierBooking_status_idx" ON "CourierBooking"("status");

CREATE TABLE IF NOT EXISTS "WhatsAppSession" (
    "phone"     TEXT NOT NULL,
    "mode"      TEXT NOT NULL DEFAULT 'idle',
    "step"      TEXT NOT NULL DEFAULT 'start',
    "data"      JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhatsAppSession_pkey" PRIMARY KEY ("phone")
);
