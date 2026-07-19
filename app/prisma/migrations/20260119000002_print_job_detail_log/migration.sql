-- Detailed print job log (customer request vs what was sent to the printer)
ALTER TABLE "EpsonPrintJob" ADD COLUMN IF NOT EXISTS "via" TEXT;
ALTER TABLE "EpsonPrintJob" ADD COLUMN IF NOT EXISTS "submittedById" TEXT;
ALTER TABLE "EpsonPrintJob" ADD COLUMN IF NOT EXISTS "customerColorMode" TEXT;
ALTER TABLE "EpsonPrintJob" ADD COLUMN IF NOT EXISTS "customerCopies" INTEGER;
ALTER TABLE "EpsonPrintJob" ADD COLUMN IF NOT EXISTS "printedColorMode" TEXT;
ALTER TABLE "EpsonPrintJob" ADD COLUMN IF NOT EXISTS "printedCopies" INTEGER;
ALTER TABLE "EpsonPrintJob" ADD COLUMN IF NOT EXISTS "printSettings" JSONB;
ALTER TABLE "EpsonPrintJob" ADD COLUMN IF NOT EXISTS "outcomeDetail" JSONB;
ALTER TABLE "EpsonPrintJob" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);
