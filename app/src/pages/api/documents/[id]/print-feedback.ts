import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { buildPrintFeedback } from "@/lib/printFeedback";
import { syncIfPendingJobs } from "@/lib/epsonNotifications";

/**
 * Latest printer confirmation for a document (EpsonPrintJob + email-notification
 * audit metadata). Optionally refreshes IMAP when a job is still pending.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });

  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  if (!isStaff && document.ownerId !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Pull mailbox when this doc (or any) still awaits confirmation.
  try {
    await syncIfPendingJobs();
  } catch {
    /* non-fatal */
  }

  const job = await prisma.epsonPrintJob.findFirst({
    where: { documentId: id },
    orderBy: { createdAt: "desc" },
  });

  const audit = await prisma.auditEvent.findFirst({
    where: {
      documentId: id,
      action: {
        in: ["epson_print_confirmed", "epson_print_failed", "email_print_failed"],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const feedback = buildPrintFeedback({
    jobStatus: job?.status,
    jobId: job?.jobId,
    jobUpdatedAt: job?.updatedAt,
    auditAction: audit?.action,
    auditMetadata: audit?.metadata,
    auditAt: audit?.createdAt,
    documentStatus: document.status,
  });

  return res.status(200).json({ feedback, documentStatus: document.status });
}
