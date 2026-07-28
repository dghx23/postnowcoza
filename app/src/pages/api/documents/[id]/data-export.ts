import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { exportDocumentPersonalData } from "@/lib/popia";

/**
 * GET /api/documents/[id]/data-export
 * POPIA right of access: a structured download of all personal information
 * held about this document (recipient details, address, payments,
 * subscribers, audit trail).
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

  const isOwner = document.ownerId === user.id;
  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  if (!isOwner && !isStaff) return res.status(403).json({ error: "Forbidden" });

  const data = await exportDocumentPersonalData(id);

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="postnow-data-${id.slice(0, 10)}.json"`);
  return res.status(200).send(JSON.stringify(data, null, 2));
}
