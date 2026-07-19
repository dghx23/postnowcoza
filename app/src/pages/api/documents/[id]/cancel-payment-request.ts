import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { cancelManualPayment } from "@/lib/manualJobReview";

/**
 * POST /api/documents/[id]/cancel-payment-request
 * Body: { justification: string, isTestEntry?: boolean }
 * Staff abandons a manual entry's payment request instead of sending it.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Only staff can cancel a payment request" });
  }

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });

  const justification =
    typeof req.body?.justification === "string" ? req.body.justification.trim() : "";
  const isTestEntry = Boolean(req.body?.isTestEntry);

  try {
    await cancelManualPayment({
      documentId: id,
      justification,
      isTestEntry,
      actorId: user.id,
      ip: req.socket.remoteAddress ?? undefined,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
}
