import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { getSessionUser } from "@/lib/session";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { documentId } = req.query;
  if (typeof documentId !== "string") {
    return res.status(400).json({ error: "Missing documentId" });
  }

  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) return res.status(404).json({ error: "Document not found" });

  const isOwner = document.ownerId === user.id;
  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  if (!isOwner && !isStaff) return res.status(403).json({ error: "Forbidden" });

  const events = await prisma.auditEvent.findMany({
    where: { documentId },
    orderBy: { createdAt: "asc" },
  });

  await appendAuditEvent({
    documentId,
    actorId: user.id,
    action: "audit_viewed",
    ip: req.socket.remoteAddress ?? undefined,
  });

  return res.status(200).json({ events });
}
