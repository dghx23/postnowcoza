import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { eraseDocumentPersonalData } from "@/lib/popia";

/**
 * POST /api/documents/[id]/erase-personal-data
 * Body: { reason: string }
 * POPIA right to erasure - staff-reviewed rather than self-service, since
 * honoring it correctly (vs. the legal retention exceptions for financial/
 * audit records) needs a judgment call, not a customer-facing button.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Only staff can action a data erasure request" });
  }

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

  try {
    await eraseDocumentPersonalData({
      documentId: id,
      reason,
      actorId: user.id,
      ip: req.socket.remoteAddress ?? undefined,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
}
