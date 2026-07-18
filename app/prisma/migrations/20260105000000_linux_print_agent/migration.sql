-- CreateEnum
CREATE TYPE "PrintProvider" AS ENUM ('EPSON', 'LINUX_AGENT');

-- CreateEnum
CREATE TYPE "LinuxPrintJobStatus" AS ENUM ('PENDING', 'PRINTED', 'FAILED');

-- CreateTable
CREATE TABLE "PrintSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "provider" "PrintProvider" NOT NULL DEFAULT 'EPSON',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinuxPrintJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" "LinuxPrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinuxPrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinuxPrintJob_documentId_idx" ON "LinuxPrintJob"("documentId");

-- CreateIndex
CREATE INDEX "LinuxPrintJob_status_idx" ON "LinuxPrintJob"("status");

-- AddForeignKey
ALTER TABLE "LinuxPrintJob" ADD CONSTRAINT "LinuxPrintJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
