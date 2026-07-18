import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { isAuthorizedAgent } from "@/lib/printAgentAuth";
import { appendAuditEvent } from "@/lib/audit";

// Same PRINTABLE_STATUSES pattern as documents/[id]/print.ts - a job can
// only actually move the document forward if it's still in a printable
// status when the agent reports back (it may have been printed manually
// in the meantime).
const PRINTABLE_STATUSES = new Set(["UPLOADED", "QUEUED_FOR_PRINT"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAuthorizedAgent(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const { success, error } = req.body ?? {};
  if (typeof success !== "boolean") {
    return res.status(400).json({ error: "success (boolean) is required" });
  }

  const job = await prisma.linuxPrintJob.findUnique({ where: { id }, include: { document: true } });
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "PENDING") {
    return res.status(409).json({ error: `Job already ${job.status.toLowerCase()}` });
  }

  if (success) {
    await prisma.linuxPrintJob.update({ where: { id }, data: { status: "PRINTED" } });

    if (PRINTABLE_STATUSES.has(job.document.status)) {
      await prisma.document.update({ where: { id: job.documentId }, data: { status: "PRINTED" } });
      await appendAuditEvent({
        documentId: job.documentId,
        action: `status_changed:${job.document.status}->PRINTED`,
        metadata: { via: "linux_agent" },
      });
    }
  } else {
    const errorMessage = typeof error === "string" ? error : "Unknown agent error";
    await prisma.linuxPrintJob.update({ where: { id }, data: { status: "FAILED", error: errorMessage } });
    await appendAuditEvent({
      documentId: job.documentId,
      action: "linux_agent_print_failed",
      metadata: { via: "linux_agent", error: errorMessage },
    });
  }

  return res.status(200).json({ id, status: success ? "PRINTED" : "FAILED" });
}
