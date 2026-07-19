-- Track staff-entered jobs for clear STAFF badge on tracking
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "createdVia" TEXT NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "staffCreatorEmail" TEXT;

-- Backfill: existing docs owned by STAFF/ADMIN were almost certainly staff job entry
UPDATE "Document" d
SET
  "createdVia" = 'STAFF',
  "staffCreatorEmail" = u.email
FROM "User" u
WHERE d."ownerId" = u.id
  AND u.role IN ('STAFF', 'ADMIN')
  AND (d."createdVia" = 'CUSTOMER' OR d."staffCreatorEmail" IS NULL);
