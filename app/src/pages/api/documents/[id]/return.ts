import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { initiateReturn } from "@/lib/returns";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  // Owner can request their own return; staff/admin can request on behalf of anyone.
  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });

  const isOwner = document.ownerId === user.id;
  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  if (!isOwner && !isStaff) return res.status(403).json({ error: "Forbidden" });

  try {
    const shipment = await initiateReturn(id, user.id);
    return res.status(201).json(shipment);
  } catch (err) {
    return res.status(422).json({ error: (err as Error).message });
  }
}
