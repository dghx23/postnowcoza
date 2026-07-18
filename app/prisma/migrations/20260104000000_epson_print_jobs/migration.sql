-- CreateTable
CREATE TABLE "EpsonPrintJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EpsonPrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EpsonPrintJob_jobId_key" ON "EpsonPrintJob"("jobId");

-- CreateIndex
CREATE INDEX "EpsonPrintJob_documentId_idx" ON "EpsonPrintJob"("documentId");

-- AddForeignKey
ALTER TABLE "EpsonPrintJob" ADD CONSTRAINT "EpsonPrintJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
