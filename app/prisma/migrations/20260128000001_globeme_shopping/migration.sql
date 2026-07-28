-- GlobeMe shopping: US product import with landed-cost calculator, PayFast checkout.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShoppingOrderStatus') THEN
    CREATE TYPE "ShoppingOrderStatus" AS ENUM (
      'DRAFT', 'QUOTED', 'AWAITING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShipMethod') THEN
    CREATE TYPE "ShipMethod" AS ENUM ('EXPRESS', 'STANDARD', 'ECONOMY');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ShoppingOrder" (
    "id"                    TEXT NOT NULL,
    "orderRef"              TEXT NOT NULL,
    "status"                "ShoppingOrderStatus" NOT NULL DEFAULT 'DRAFT',

    "customerEmail"         TEXT NOT NULL,
    "customerPhone"         TEXT,
    "recipientName"         TEXT NOT NULL,
    "recipientPhone"        TEXT NOT NULL,
    "recipientStreet"       TEXT NOT NULL,
    "recipientCity"         TEXT NOT NULL,
    "recipientProvince"     TEXT NOT NULL,
    "recipientPostalCode"   TEXT NOT NULL,
    "recipientCountry"      TEXT NOT NULL DEFAULT 'ZA',

    "productUrl"            TEXT NOT NULL,
    "productName"           TEXT,
    "productPrice"          DOUBLE PRECISION,
    "productWeight"         DOUBLE PRECISION,

    "shipMethod"            "ShipMethod" NOT NULL DEFAULT 'STANDARD',
    "extraWeightSurcharge"  DOUBLE PRECISION NOT NULL DEFAULT 0,

    "personalShopperFee"    DOUBLE PRECISION NOT NULL DEFAULT 0,
    "markupPercent"         DOUBLE PRECISION NOT NULL DEFAULT 15,

    "itemPriceCents"        INTEGER,
    "shippingCostCents"     INTEGER,
    "shopperFeeCents"       INTEGER,
    "hsCode"                TEXT,
    "dutyRate"              DOUBLE PRECISION,
    "dutyCents"             INTEGER,
    "vatCents"              INTEGER,
    "landedCostCents"       INTEGER,
    "finalQuoteCents"       INTEGER,
    "finalQuoteZar"         DOUBLE PRECISION,

    "payFastPaymentId"      TEXT,
    "payFastUuid"           TEXT,
    "payFastUrl"            TEXT,
    "paidAt"                TIMESTAMP(3),

    "bobgoShipmentId"       TEXT,

    "fxRateUsdzarSnapshot"  DOUBLE PRECISION,

    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShoppingOrder_orderRef_key" ON "ShoppingOrder"("orderRef");
CREATE INDEX IF NOT EXISTS "ShoppingOrder_customerEmail_idx" ON "ShoppingOrder"("customerEmail");
CREATE INDEX IF NOT EXISTS "ShoppingOrder_status_idx" ON "ShoppingOrder"("status");
