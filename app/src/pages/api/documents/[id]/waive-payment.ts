import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { waivePayment } from "@/lib/manualJobReview";

/**
 * POST /api/documents/[id]/waive-payment
 * Body: { justification: string, amount: number, isTestEntry?: boolean }
 * Staff processes this manual entry's dispatch fee at no cost (at
 * PostNow's expense) - lands in the finance review queue, not real revenue.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Only staff can process a job at no cost" });
  }

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });

  const justification =
    typeof req.body?.justification === "string" ? req.body.justification.trim() : "";
  const amount = Number(req.body?.amount);
  const isTestEntry = Boolean(req.body?.isTestEntry);

  try {
    await waivePayment({
      documentId: id,
      justification,
      amount,
      isTestEntry,
      actorId: user.id,
      ip: req.socket.remoteAddress ?? undefined,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
}
