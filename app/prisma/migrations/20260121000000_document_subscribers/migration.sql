-- People (besides the document owner) who were sent a booking share and
-- opted in to future status updates by email or WhatsApp.
CREATE TABLE IF NOT EXISTS "DocumentSubscriber" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentSubscriber_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DocumentSubscriber_documentId_idx" ON "DocumentSubscriber"("documentId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DocumentSubscriber_documentId_fkey'
  ) THEN
    ALTER TABLE "DocumentSubscriber"
      ADD CONSTRAINT "DocumentSubscriber_documentId_fkey"
      FOREIGN KEY ("documentId") REFERENCES "Document"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
