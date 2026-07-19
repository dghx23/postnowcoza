import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { getSessionUser } from "@/lib/session";
import { maybeAutoDispatchIfPaid } from "@/lib/autoDispatch";

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
  const { status: nextStatus } = req.body as { status?: string };
  if (typeof id !== "string" || !nextStatus) {
    return res.status(400).json({ error: "Missing id or status" });
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

  await appendAuditEvent({
    documentId: id,
    actorId: user.id,
    action: `status_changed:${document.status}->${nextStatus}`,
    ip: req.socket.remoteAddress ?? undefined,
  });

  if (nextStatus === "PRINTED") {
    try {
      await maybeAutoDispatchIfPaid(id, user.id);
    } catch {
      /* non-fatal — staff can dispatch manually */
    }
  }

  return res.status(200).json({ id: updated.id, status: updated.status });
}
