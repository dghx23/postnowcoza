import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { sendDispatchPaymentRequest } from "@/lib/paymentRequestEmail";

/**
 * Staff: email a payment request for this document's dispatch fee.
 * Body: { email: string }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Only staff can send payment requests" });
  }

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });

  const email =
    typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email address is required" });
  }

  try {
    const result = await sendDispatchPaymentRequest({
      documentId: id,
      toEmail: email,
      actorId: user.id,
      ip: req.socket.remoteAddress ?? undefined,
    });
    return res.status(200).json({
      ok: true,
      ...result,
      message: `Payment request sent to ${email}`,
    });
  } catch (err) {
    console.error("Payment request email failed", (err as Error).message);
    return res.status(502).json({ error: (err as Error).message });
  }
}
