import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { getSessionUser } from "@/lib/session";
import { maybeAutoDispatchIfPaid } from "@/lib/autoDispatch";
import { getPrintSettings } from "@/lib/printSettings";
import { resolveJobPrintSettings } from "@/lib/printJobSettings";
import { customerRequestFromDocument, recordPrintJobSubmission } from "@/lib/printJobLog";

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  UPLOADED: ["QUEUED_FOR_PRINT", "PRINTED"],
  QUEUED_FOR_PRINT: ["PRINTED"],
  PRINTED: ["DISPATCHED"],
  DISPATCHED: ["IN_TRANSIT"],
  IN_TRANSIT: ["DELIVERED", "RETURNED"],
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { id } = req.query;
  const body = (req.body ?? {}) as {
    status?: string;
    comment?: string;
    confirmed?: boolean;
  };
  const nextStatus = body.status;
  if (typeof id !== "string" || !nextStatus) {
    return res.status(400).json({ error: "Missing id or status" });
  }

  // Manual "Mark Printed" requires an explicit confirmation tick from staff.
  if (nextStatus === "PRINTED") {
    if (body.confirmed !== true) {
      return res.status(400).json({
        error: "Confirm that the document was printed before marking it printed",
      });
    }
  }

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });

  const allowed = ALLOWED_TRANSITIONS[document.status] ?? [];
  if (!allowed.includes(nextStatus)) {
    return res.status(409).json({
      error: `Cannot transition from ${document.status} to ${nextStatus}`,
    });
  }

  const updated = await prisma.document.update({
    where: { id },
    data: { status: nextStatus as never },
  });

  const comment =
    typeof body.comment === "string" ? body.comment.trim().slice(0, 2000) : "";

  let printLogSummary: string | undefined;

  if (nextStatus === "PRINTED") {
    // Log customer request vs assumed printed settings for manual confirmation.
    const facility = await getPrintSettings();
    const customer = customerRequestFromDocument(document);
    const printed = resolveJobPrintSettings({
      facility: {
        printPaperSize: facility.printPaperSize,
        printPaperType: facility.printPaperType,
        printQuality: facility.printQuality,
        printPaperSource: facility.printPaperSource,
        printBorderless: facility.printBorderless,
        printDoubleSided: facility.printDoubleSided,
      },
      customer: {
        printColorMode: customer.colorMode,
        printCopies: customer.copies,
      },
    });
    const { summary } = await recordPrintJobSubmission({
      documentId: id,
      jobId: `manual-mark:${document.id}:${Date.now()}`,
      via: "manual_mark",
      actorId: user.id,
      customer,
      printed,
      status: "completed",
      extraMeta: {
        confirmed: true,
        ...(comment ? { comment } : {}),
        note: "Staff manually confirmed print; settings assumed from customer request + facility defaults.",
      },
      ip: req.socket.remoteAddress ?? undefined,
    });
    printLogSummary = summary;
  }

  await appendAuditEvent({
    documentId: id,
    actorId: user.id,
    action: `status_changed:${document.status}->${nextStatus}`,
    metadata: {
      via: "manual_mark",
      confirmed: body.confirmed === true,
      ...(comment ? { comment } : {}),
      ...(printLogSummary ? { printLog: printLogSummary } : {}),
    },
    ip: req.socket.remoteAddress ?? undefined,
  });

  if (nextStatus === "PRINTED") {
    try {
      await maybeAutoDispatchIfPaid(id, user.id);
    } catch {
      /* non-fatal — staff can dispatch manually */
    }
  }

  return res.status(200).json({ id: updated.id, status: updated.status, printLog: printLogSummary });
}
