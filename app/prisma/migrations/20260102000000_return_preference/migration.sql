-- CreateEnum
CREATE TYPE "ReturnPreference" AS ENUM ('DIRECT', 'MANAGED');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "returnPreference" "ReturnPreference" NOT NULL DEFAULT 'MANAGED';

