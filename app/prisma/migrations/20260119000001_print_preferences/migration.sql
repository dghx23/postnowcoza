-- Customer print preferences on each document
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "printColorMode" TEXT NOT NULL DEFAULT 'mono';
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "printCopies" INTEGER NOT NULL DEFAULT 1;

-- Facility default print job settings (Printer Hub manual adjusters)
ALTER TABLE "PrintSettings" ADD COLUMN IF NOT EXISTS "printPaperSize" TEXT NOT NULL DEFAULT 'ps_a4';
ALTER TABLE "PrintSettings" ADD COLUMN IF NOT EXISTS "printPaperType" TEXT NOT NULL DEFAULT 'pt_plainpaper';
ALTER TABLE "PrintSettings" ADD COLUMN IF NOT EXISTS "printQuality" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "PrintSettings" ADD COLUMN IF NOT EXISTS "printPaperSource" TEXT NOT NULL DEFAULT 'rear';
ALTER TABLE "PrintSettings" ADD COLUMN IF NOT EXISTS "printBorderless" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PrintSettings" ADD COLUMN IF NOT EXISTS "printDoubleSided" TEXT NOT NULL DEFAULT 'none';
