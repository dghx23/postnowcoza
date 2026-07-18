import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getDocumentDownloadUrl } from "@/lib/storage";
import { appendAuditEvent } from "@/lib/audit";

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

  const isOwner = document.ownerId === user.id;
  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  if (!isOwner && !isStaff) return res.status(403).json({ error: "Forbidden" });

  const url = await getDocumentDownloadUrl(document.storageKey);

  await appendAuditEvent({
    documentId: document.id,
    actorId: user.id,
    action: "document_downloaded",
    ip: req.socket.remoteAddress ?? undefined,
  });

  return res.status(200).json({ url });
}
