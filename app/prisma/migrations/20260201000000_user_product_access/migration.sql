-- Per-product staff/admin access grants, layered on top of User.role.
-- Purely additive: does not touch Payment, Document, CourierBooking, or
-- ShoppingOrder. See schema.prisma for the reasoning.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Product') THEN
    CREATE TYPE "Product" AS ENUM ('E2', 'EXPRESS', 'GLOBEME', 'MIDL');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "UserProductAccess" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "product"   "Product" NOT NULL,
    "role"      "Role" NOT NULL DEFAULT 'STAFF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserProductAccess_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UserProductAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserProductAccess_userId_product_key" ON "UserProductAccess"("userId", "product");
CREATE INDEX IF NOT EXISTS "UserProductAccess_userId_idx" ON "UserProductAccess"("userId");
