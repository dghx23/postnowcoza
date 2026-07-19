import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  sendDispatchPaymentRequest,
  sendDispatchPaymentRequestWhatsApp,
} from "@/lib/paymentRequestEmail";
import { isValidWhatsAppPhone, isWhatsAppConfigured } from "@/lib/whatsapp";

/**
 * Staff: send a payment request for this document's dispatch fee.
 * Body:
 *   { channel: "email", email: string }
 *   { channel: "whatsapp", phone: string }
 * Legacy: { email: string } → email channel
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

  const justification =
    typeof req.body?.justification === "string" ? req.body.justification.trim() : "";
  const isTestEntry = Boolean(req.body?.isTestEntry);
  if (document.createdVia === "STAFF" && !justification) {
    return res.status(400).json({ error: "Justification is required for this staff-created entry" });
  }
  const manualEntry = document.createdVia === "STAFF" ? { justification, isTestEntry } : undefined;

  const channelRaw =
    typeof req.body?.channel === "string" ? req.body.channel.trim().toLowerCase() : "";
  // Explicit channel wins; legacy body with only phone → whatsapp
  const hasEmail =
    typeof req.body?.email === "string" && req.body.email.trim().length > 0;
  const hasPhone =
    typeof req.body?.phone === "string" && req.body.phone.trim().length > 0;
  const resolvedChannel: "email" | "whatsapp" =
    channelRaw === "whatsapp" || (channelRaw === "" && hasPhone && !hasEmail)
      ? "whatsapp"
      : "email";

  try {
    if (resolvedChannel === "whatsapp") {
      if (!isWhatsAppConfigured()) {
        return res.status(503).json({
          error:
            "WhatsApp is not configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID)",
        });
      }
      const phone =
        typeof req.body?.phone === "string"
          ? req.body.phone.trim()
          : document.recipientPhone || "";
      if (!phone || !isValidWhatsAppPhone(phone)) {
        return res.status(400).json({
          error: "A valid phone number is required for WhatsApp (e.g. 0731234567 or +27731234567)",
        });
      }
      const result = await sendDispatchPaymentRequestWhatsApp({
        documentId: id,
        toPhone: phone,
        actorId: user.id,
        ip: req.socket.remoteAddress ?? undefined,
        manualEntry,
      });
      return res.status(200).json({
        ok: true,
        channel: "whatsapp",
        ...result,
        message: `Payment request WhatsApp sent to ${result.to}`,
      });
    }

    const email =
      typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }

    const result = await sendDispatchPaymentRequest({
      documentId: id,
      toEmail: email,
      actorId: user.id,
      ip: req.socket.remoteAddress ?? undefined,
      manualEntry,
    });
    return res.status(200).json({
      ok: true,
      channel: "email",
      ...result,
      message: `Payment request sent to ${email}`,
    });
  } catch (err) {
    console.error("Payment request failed", (err as Error).message);
    return res.status(502).json({ error: (err as Error).message });
  }
}
