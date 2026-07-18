-- AlterEnum
BEGIN;
CREATE TYPE "PrintProvider_new" AS ENUM ('EPSON', 'EPSON_DIRECT');
ALTER TABLE "PrintSettings" ALTER COLUMN "provider" DROP DEFAULT;
ALTER TABLE "PrintSettings" ALTER COLUMN "provider" TYPE "PrintProvider_new" USING ("provider"::text::"PrintProvider_new");
ALTER TYPE "PrintProvider" RENAME TO "PrintProvider_old";
ALTER TYPE "PrintProvider_new" RENAME TO "PrintProvider";
DROP TYPE "PrintProvider_old";
ALTER TABLE "PrintSettings" ALTER COLUMN "provider" SET DEFAULT 'EPSON';
COMMIT;

-- DropForeignKey
ALTER TABLE "LinuxPrintJob" DROP CONSTRAINT "LinuxPrintJob_documentId_fkey";

-- AlterTable
ALTER TABLE "PrintSettings" ADD COLUMN     "epsonDirectEmail" TEXT;

-- DropTable
DROP TABLE "LinuxPrintJob";

-- DropEnum
DROP TYPE "LinuxPrintJobStatus";
